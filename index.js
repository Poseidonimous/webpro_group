const express = require("express");
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require("path");
const cors = require('cors');
const port = process.env.PORT || 3000;
const sqlite3 = require('sqlite3').verbose();

const app = express();

// Connect to SQLite database
let db = new sqlite3.Database('database.db', (err) => {    
  if (err) {
      return console.error(err.message);
  }
  console.log('Connected to the SQlite database.');
});

app.use(express.static('public'));
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

//USE session
app.use(session({
    secret: 'your-secret-key', 
    resave: false,             
    saveUninitialized: true,   
    cookie: { secure: false }  
}));

//Use Cookie
app.use(cookieParser());

// ฟังก์ชันกลางสำหรับคำนวณวินาทีคงเหลือ (ใช้ร่วมกันได้ทุก Route)
function getRemainingSeconds(req, user) {
  const now = Date.now();
  const dbMinutes = user.remaining_time_minute || 0;

  // ตั้ง session_end_time ใหม่ "เฉพาะ" กรณีที่ยังไม่มี หรือผู้ใช้เพิ่งเติมเวลาเพิ่มเข้ามาเท่านั้น
  if (!req.session.session_end_time || req.session.last_db_minutes !== dbMinutes) {
    req.session.session_end_time = now + (dbMinutes * 60 * 1000);
    req.session.last_db_minutes = dbMinutes;
  }

  // คำนวณวินาทีคงเหลือจาก session_end_time เดิมที่มีอยู่
  let remainingSeconds = Math.max(0, Math.floor((req.session.session_end_time - now) / 1000));

  // อัปเดตนาทีลง DB เมื่อเวลาผ่านไป
  const currentMinutes = Math.ceil(remainingSeconds / 60);
  if (currentMinutes !== dbMinutes) {
    db.run(`UPDATE user SET remaining_time_minute = ? WHERE user_id = ?`, [currentMinutes, user.user_id]);
    req.session.last_db_minutes = currentMinutes;
  }

  return remainingSeconds;
}

// ==========================================
// Helper: การชำระเงิน (ใช้ร่วมกันระหว่าง payment / cart / prompt-pay)
// ==========================================
const PROMPTPAY = 'พร้อมเพย์';

// เช็คว่าวิธีชำระเงินที่ส่งมาคือ "พร้อมเพย์" หรือไม่
function isPromptPay(method) {
  const m = String(method || '').toLowerCase().replace(/[\s_-]/g, '');
  return m.includes('พร้อมเพย์') || m.includes('promptpay');
}

// อ่านตะกร้าจาก Cookie
function readCart(req) {
  if (!req.cookies.cart) return [];
  try {
    const cart = JSON.parse(req.cookies.cart);
    return Array.isArray(cart) ? cart : [];
  } catch (e) {
    return [];
  }
}

// คำนวณยอดรวมของตะกร้าจากราคาใน Database (ไม่เชื่อราคาจากฝั่ง client)
function calcCartTotal(cart, callback) {
  const ids = cart.map(item => parseInt(item.product_id, 10)).filter(Number.isInteger);
  if (ids.length === 0) return callback(null, 0, []);

  const placeholders = ids.map(() => '?').join(',');
  db.all(`SELECT product_id, price FROM product WHERE product_id IN (${placeholders})`, ids, (err, products) => {
    if (err) return callback(err);

    let totalAmount = 0;
    const orderDetails = [];

    cart.forEach(item => {
      const product = products.find(p => p.product_id == item.product_id);
      const quantity = parseInt(item.quantity, 10);
      if (product && quantity > 0) {
        const subtotal = product.price * quantity;
        totalAmount += subtotal;
        orderDetails.push({
          productId: item.product_id,
          quantity: quantity,
          unitPrice: product.price,
          subtotal: subtotal
        });
      }
    });

    callback(null, totalAmount, orderDetails);
  });
}

// บันทึกการซื้อแพ็กเกจเวลา (customer)
function processPackagePayment(req, res, pay_method) {
  const package = req.session.package;
  const order_id = 'ORD' + Date.now();
  const user_id = req.session.user_id;

  //ดึงวันที่และเวลาปัจจุบันของประเทศไทย (UTC+7) ในฟอร์แมต YYYY-MM-DD HH:mm:ss
  const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" });

  const price_sql = `SELECT * FROM product WHERE product_id = ? AND is_active = 1`;
  db.get(price_sql, [package], function(err, product) {
    if(err || !product) {
      console.log(err);
      return res.redirect("/customer/buy_time");
    }
    const order_sql = `INSERT INTO orders(order_id, user_id, total_amount, order_status, created_at) VALUES (?, ?, ?, ?, ?)`;
    db.run(order_sql, [order_id, user_id, product.price, 'เสร็จสิ้น', now], function(error) {
      if(error) {
        console.log(error);
        return res.redirect("/customer/buy_time");
      }

      const payment_sql = `INSERT INTO payment(order_id, payment_method, amount, paid_at) VALUES(?, ?, ?, ?)`;
      db.run(payment_sql, [order_id, pay_method, product.price, now], function(err) {
        if(err) {
          console.log(err);
          return res.redirect("/customer/buy_time");
        }

        const detail_sql = `INSERT INTO order_detail(order_id, product_id, quantity, unit_price, subtotal) VALUES (?, ?, 1, ?, ?)`;
        db.run(detail_sql, [order_id, product.product_id, product.price, product.price], function(err) {
          if(err) {
            console.log(err);
            return res.redirect("/customer/buy_time");
          }

          const add_time_sql = `UPDATE user SET remaining_time_minute = remaining_time_minute + ? WHERE user_id = ?`;
          const timeMap = { 1: 30, 2: 60, 3: 90, 4: 120, 5: 150, 6: 180 };
          const minutesToAdd = timeMap[product.product_id] || 0;

          if (minutesToAdd === 0) {
            console.log("ไม่พบแพ็กเกจเวลาสำหรับ product_id:", product.product_id);
            return res.status(400).send("แพ็กเกจเวลาไม่ถูกต้อง");
          }

          db.run(add_time_sql, [minutesToAdd, user_id], function(err) {
            if(err) {
              console.log(err);
              return res.redirect("/customer/buy_time");
            }
            console.log(`USER : ${user_id} has Buy time for ${minutesToAdd} minute Successfully`);

            delete req.session.package;
            delete req.session.session_end_time;
            delete req.session.pending_payment;

            return res.send(`
              <script>
                alert('ซื้อเวลาเสร็จสิ้น');
                window.location.href = '/customer/home';
              </script>
            `);
          });
        });
      });
    });
  });
}

// บันทึกการซื้อสินค้าในตะกร้า (customer และ service ใช้ร่วมกัน)
// homeUrl = หน้าที่จะพากลับหลังซื้อเสร็จ เช่น '/customer/home' หรือ '/service/home'
function processCartPayment(req, res, paymentMethod, homeUrl) {
  const cart = readCart(req);

  // ถ้าไม่มีของในตะกร้าให้เด้งกลับไปหน้าแรก
  if (cart.length === 0) {
    return res.redirect(homeUrl);
  }

  const userId = req.session.user_id || 1;
  const orderId = "ORD" + Date.now();

  // ⭐️ ดึงวันที่และเวลาปัจจุบันของประเทศไทย (UTC+7) ในฟอร์แมต YYYY-MM-DD HH:mm:ss
  const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" });

  calcCartTotal(cart, (err, totalAmount, orderDetails) => {
    if (err) {
      console.error(err);
      return res.status(500).send("เกิดข้อผิดพลาดในการดึงข้อมูลสินค้า");
    }

    if (orderDetails.length === 0) {
      return res.redirect(homeUrl);
    }

    // ==========================================
    // เริ่มบันทึกลง Database
    // ==========================================
    db.serialize(() => {
      // ตาราง orders (ใช้ 'รอจัดเตรียม' แทน เพื่อเลี่ยงสระ ำ)
      db.run(`INSERT INTO orders (order_id, user_id, total_amount, order_status, created_at) VALUES (?, ?, ?, 'รอจัดเตรียม', ?)`,
        [orderId, userId, totalAmount, now], function(err) {
        if (err) {
          console.error("Error inserting orders:", err);
          return res.status(500).send("บันทึกออเดอร์ไม่สำเร็จ");
        }

        // ตาราง order_detail: บันทึกรายการสินค้าแต่ละชิ้น
        const stmt = db.prepare(`INSERT INTO order_detail (order_id, product_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)`);
        orderDetails.forEach(detail => {
          stmt.run(orderId, detail.productId, detail.quantity, detail.unitPrice, detail.subtotal);
        });
        stmt.finalize();

        // ตาราง payment
        db.run(`INSERT INTO payment (order_id, payment_method, amount, paid_at) VALUES (?, ?, ?, ?)`,
          [orderId, paymentMethod, totalAmount, now], function(err) {
          if (err) {
            console.error("Error inserting payment:", err);
            return res.status(500).send("บันทึกการชำระเงินไม่สำเร็จ");
          }

          // เมื่อบันทึกสำเร็จทั้งหมด ให้ลบ Cookie ตะกร้าสินค้าออก
          res.clearCookie('cart');
          delete req.session.pending_payment;

          return res.send(`
            <script>
              alert('ซื้อสินค้าเสร็จสิ้น');
              window.location.href = '${homeUrl}';
            </script>
          `);
        });
      });
    });
  });
}

//LOGIN and Give PATH and Session
app.get("/", (req, res) => {
  res.render('login');
});

app.post("/login", (req,res)=> {
  const sql = `SELECT * FROM user WHERE email = ? AND password = ?`;
  const email = req.body.email;
  const password = req.body.password;

  db.get(sql, [email,password], (err,data) => {
    if(err) {
      console.log(err);
    }
    if(!data) {
      console.log(`Login Failed For Email: ${email}`);
      return res.send(`
        <script>
          alert('อีเมล หรือ รหัสผ่านไม่ถูกต้อง');
          window.location.href = '/';
        </script>
      `);
    }

    console.log(`USER : ${email} has been loged in.`);
    req.session.name = data.user_name;
    req.session.email = data.email;
    req.session.role = data.role;
    req.session.user_id = data.user_id;

    switch(data.role) {
      case `customer`:
        return res.redirect(`/customer/home`);
      case `service`:
        return res.redirect(`/service/home`);
      case `chef`:
        return res.redirect(`/chef/home`);
      default:
        return res.redirect('/');
    }
  });
});


//REGISTER
app.get("/register", (req, res) => {
  res.render('register');
});

app.post("/register", (req,res) => {
  const name = req.body.name;
  const email = req.body.email;
  const password = req.body.password;
  const confirm_password = req.body.confirmPassword;

  if (name.length < 2 || name.length > 16) {
    console.log(`Register Failed (Name Length) For Name: ${name}`);
    return res.send(`
      <script>
        alert('ชื่อผู้ใช้ต้องมีความยาวระหว่าง 2 - 16 ตัวอักษร');
        window.location.href = '/register';
      </script>
    `);
  }

  if(password !== confirm_password){
    console.log(`Register Failed (Password Mismatch) For Email: ${email}`);
    return res.send(`
      <script>
        alert('โปรดเช็คความถุูกต้องของรหัสผ่าน');
        window.location.href = '/register';
      </script>
    `);
  }

  const check_sql = `SELECT * FROM user WHERE email = ?`;
  db.get(check_sql, [email], (err,data) => {
    if(err){
      console.log(err);
    }

    if(data){
      console.log(`Register Failed (Email Exists) For Email: ${email}`);
      return res.send(`
        <script>
          alert('อีเมลนี้ถูกใช้งานแล้ว');
          window.location.href = '/register';
        </script>
      `);
    }

    if(!data){
      const insert_sql = `INSERT INTO user (email, password, role, remaining_time_minute, user_name) VALUES ( ?, ?, 'customer', 0, ?)`;
      db.run(insert_sql, [email, password, name], function(err) {
        if(err){
          console.log(err);
        }
        console.log(`Register Succesfully for Email : ${email} (ID: ${this.lastID})`);
        return res.send(`
        <script>
          alert('สมัครบัญชีผู้ใช้สำเร็จ');
          window.location.href = '/';
        </script>
      `);
      });
    }
  });
});

// customer PATH
app.get("/customer/home", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `customer`) {
    return res.redirect("/");
  }

  if (!req.session.user_id) return res.redirect("/");

  db.get(`SELECT * FROM user WHERE user_id = ?`, [req.session.user_id], (err, user) => {
    if (err || !user) return res.redirect("/");

    const remainingSeconds = getRemainingSeconds(req, user);

    // ถ้าเวลาหมดแล้ว ให้ Redirect ไปหน้าซื้อเวลาทันทีแบบเงียบๆ
    if (remainingSeconds <= 0) {
      return res.redirect("/customer/buy_time");
    }

    res.render("customer/home", {
      userName: user.user_name || "ผู้เล่น",
      endTime: req.session.session_end_time
    });
  });
});

//CUSTOMER BUY TIME
app.get("/customer/buy_time", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `customer`) {
    return res.redirect("/");
  }

  if (!req.session.user_id) return res.redirect("/");

  db.get(`SELECT * FROM user WHERE user_id = ?`, [req.session.user_id], (err, user) => {
    if (err || !user) return res.redirect("/");

    const remainingSeconds = getRemainingSeconds(req, user);

    res.render("customer/buytime", {
      remainingSeconds: remainingSeconds,
      endTime: req.session.session_end_time
    });
  });
});

app.post("/buy_time", (req,res) => {
  const package = req.body.package;
  req.session.package = package;

  res.redirect("/customer/payment");
});

//CUSTOMER PAYMENT
app.get("/customer/payment", (req,res)=>{
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `customer`) {
    return res.redirect("/");
  }

  if (!req.session.package && req.session.role !== `customer`) {
    return res.redirect("/");
  }

  if (!req.session.package && req.session.role == `customer`) {
    return res.redirect("/customer/home");
  }

  const sql = `SELECT * FROM product WHERE product_id = ? AND is_active = "1"`;
  const package = req.session.package;

  db.get(sql, [package], function(err, data) {
    if(err) {
      console.log(err);
    }
    res.render('customer/payment', {package : data})
  });
});

//CUSTOMER PURCHASE A TIME
app.post("/payment", (req,res) => {
  const pay_method = req.body.payment_method;

  // เลือกพร้อมเพย์ -> ไปหน้า /customer/prompt-pay ก่อน (ยังไม่บันทึกออเดอร์)
  if (isPromptPay(pay_method)) {
    if (!req.session.user_id || req.session.role !== `customer` || !req.session.package) {
      return res.redirect("/customer/buy_time");
    }
    req.session.pending_payment = { role: 'customer', type: 'package' };
    return res.redirect("/customer/prompt-pay");
  }

  // วิธีอื่น บันทึกทันทีเหมือนเดิม
  processPackagePayment(req, res, pay_method);
});


//CUSTOMER ORDER
app.get("/customer/order", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `customer`) {
    return res.redirect("/");
  }

  res.render('customer/menu');
});

//API SEND MENU BY CATEGORY
app.get("/api/products", (req, res) => {
    const category = req.query.category || 'all';
    
    if(category === 'all') {
      const sql = `SELECT * FROM product WHERE category_id <> 1`;
      db.all(sql, function(err,dataFromDB) {
        if(err){
          console.log(err);
        }
        res.json(dataFromDB);
      });
    }

    else{
      const product_sql = `SELECT * FROM product WHERE category_id = ?`;
      db.all(product_sql, [category], function(err,dataFromDB) {
        if(err){
        console.log(err);
      }
      res.json(dataFromDB);
      });
    }
});

//CUSTOMER CART ITEM
app.get("/customer/cart", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `customer`) {
    return res.redirect("/");
  }

  res.render('customer/cart');
});

//CUSTOMER PURCHASE IN CART
app.post("/cart_payment", (req, res) => {
  const paymentMethod = req.body.payment_method || PROMPTPAY;

  // เลือกพร้อมเพย์ -> ไปหน้า /customer/prompt-pay ก่อน (ยังไม่บันทึกออเดอร์)
  if (isPromptPay(paymentMethod)) {
    if (readCart(req).length === 0) {
      return res.redirect('/customer/home');
    }
    req.session.pending_payment = { role: 'customer', type: 'cart' };
    return res.redirect('/customer/prompt-pay');
  }

  // วิธีอื่น บันทึกทันทีเหมือนเดิม
  processCartPayment(req, res, paymentMethod, '/customer/home');
});


//CUSTOMER BUYING HISTORY
app.get("/customer/history", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `customer`) {
    return res.redirect("/");
  }

  const user_id = req.session.user_id;
  const sql = `
  SELECT o.order_id, o.created_at, o.total_amount, o.order_status, p.payment_method
  FROM orders o
  LEFT JOIN payment p ON o.order_id = p.order_id
  WHERE o.user_id = ?
  ORDER BY o.order_id DESC
  `;
  db.all(sql, [user_id], function(err, data) {
    if(err){
      console.log(err);
    }
    res.render('customer/history', {history:data});
  });
});

// API สำหรับลูกค้าเช็คสถานะออเดอร์ของตัวเอง
app.get("/api/customer/my-orders", (req, res) => {
    if (!req.session.user_id) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const userId = req.session.user_id;
    // ดึงออเดอร์ของลูกค้ารายนี้
    const sql = `
        SELECT order_id, order_status, total_amount, created_at 
        FROM orders 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT 10
    `;

    db.all(sql, [userId], (err, orders) => {
        if (err) {
            console.error("Fetch customer orders error:", err);
            return res.status(500).json({ error: "Database error" });
        }
        res.json(orders || []);
    });
});


// Service Path
app.get("/service/home", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `service`) {
    return res.redirect("/");
  }

  const sql = `SELECT * FROM user WHERE user_id = ?`;
  db.get(sql, [req.session.user_id], (err, user) => {
    if (err || !user) {
      console.log("Fetch User Error:", err);
      return res.redirect("/");
    }

    res.render("service/home", {
      user_name: user.user_name || "พนักงานบริการ"
    });
  });
});

//SERVICE ORDER
app.get("/service/order", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `service`) {
    return res.redirect("/");
  }

  res.render('service/menu');
});

//API SEND MENU BY CATEGORY
app.get("/api/products", (req, res) => {
    const category = req.query.category || 'all';
    
    if(category === 'all') {
      const sql = `SELECT * FROM product WHERE category_id <> 1`;
      db.all(sql, function(err,dataFromDB) {
        if(err){
          console.log(err);
        }
        res.json(dataFromDB);
      });
    }

    else{
      const product_sql = `SELECT * FROM product WHERE category_id = ?`;
      db.all(product_sql, [category], function(err,dataFromDB) {
        if(err){
        console.log(err);
      }
      res.json(dataFromDB);
      });
    }
});

//SERVICE CART ITEM
app.get("/service/cart", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `service`) {
    return res.redirect("/");
  }

  res.render('service/cart');
});

//SERVICE PURCHASE IN CART
app.post("/service_cart_payment", (req, res) => {
  const paymentMethod = req.body.payment_method || PROMPTPAY;

  // เลือกพร้อมเพย์ -> ไปหน้า /service/prompt-pay ก่อน (ยังไม่บันทึกออเดอร์)
  if (isPromptPay(paymentMethod)) {
    if (readCart(req).length === 0) {
      return res.redirect('/service/home');
    }
    req.session.pending_payment = { role: 'service', type: 'cart' };
    return res.redirect('/service/prompt-pay');
  }

  // วิธีอื่น บันทึกทันทีเหมือนเดิม
  processCartPayment(req, res, paymentMethod, '/service/home');
});

//SERVICE BUYING HISTORY(ALL)
app.get("/service/history", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `service`) {
    return res.redirect("/");
  }

  const sql = `
  SELECT o.order_id, o.created_at, o.total_amount, o.order_status, p.payment_method
  FROM orders o
  LEFT JOIN payment p ON o.order_id = p.order_id
  ORDER BY o.order_id DESC
  `;
  db.all(sql, function(err, data) {
    if(err){
      console.log(err);
    }
    res.render('service/history', {history:data});
  });
});


// Chef Path
app.get("/chef/home", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `chef`) {
    return res.redirect("/");
  }

  const sql = `SELECT * FROM user WHERE user_id = ?`;
  db.get(sql, [req.session.user_id], (err, user) => {
    if (err || !user) {
      console.log("Fetch User Error:", err);
      return res.redirect("/");
    }

    res.render("chef/home", {
      user_name: user.user_name || "พ่อครัวใหญ่"
    });
  });
});

app.get("/chef/history", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `chef`) {
    return res.redirect("/");
  }

  const sql = `
  SELECT o.order_id, o.created_at, o.total_amount, o.order_status, p.payment_method
  FROM orders o
  LEFT JOIN payment p ON o.order_id = p.order_id
  WHERE o.order_status <> "รอจัดเตรียม"
  ORDER BY o.order_id DESC
  `;
  db.all(sql, function(err, data) {
    if(err){
      console.log(err);
    }
    res.render('chef/history', {history:data});
  });
});

app.get("/chef/orders", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `chef`) {
    return res.redirect("/");
  }

  const sql = `
  SELECT o.order_id, o.created_at, o.total_amount, o.order_status, p.payment_method
  FROM orders o
  LEFT JOIN payment p ON o.order_id = p.order_id
  WHERE o.order_status = "รอจัดเตรียม"
  ORDER BY o.order_id DESC
  `;
  db.all(sql, function(err, data) {
    if(err){
      console.log(err);
    }
    res.render('chef/orders', {history:data});
  });
});

app.get("/api/chef/orders", (req, res) => {
  // ตรวจสอบสิทธิ์ (ถ้าไม่ใช่เชฟ จะส่งกลับเป็น Error ป้องกันคนนอกดึงข้อมูล)
  if (!req.session.user_id || req.session.role !== 'chef') {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sql = `
  SELECT o.order_id, o.created_at, o.total_amount, o.order_status, p.payment_method
  FROM orders o
  LEFT JOIN payment p ON o.order_id = p.order_id
  WHERE o.order_status = "รอจัดเตรียม"
  ORDER BY o.order_id DESC
  `;
  
  db.all(sql, function(err, data) {
    if(err){
      console.log(err);
      return res.status(500).json({ error: "Database error" });
    }
    // ส่งข้อมูลกลับไปเป็น JSON
    res.json(data);
  });
});

app.get("/chef/order/:id", (req, res) => {
  if (!req.session.user_id) {
    return res.redirect("/");
  }

  if (req.session.role !== `chef`) {
    return res.redirect("/");
  }

  const order_id = req.params.id; 
  // 1. เพิ่ม d.order_id เข้าไปใน SELECT
  const sql = `
    SELECT d.order_id, p.name, d.unit_price, d.quantity, d.subtotal, o.total_amount
    FROM order_detail d
    LEFT JOIN product p ON d.product_id = p.product_id
    INNER JOIN orders o ON d.order_id = o.order_id
    WHERE d.order_id = ?
  `;
  
  db.all(sql, [order_id], function(err, menu) { 
    if(err) {
      console.log("SQL Error:", err);
      return res.status(500).send("Database error");
    }
    
    // 2. เปลี่ยนชื่อ Property เป็น 'menu' เพื่อให้ตรงกับไฟล์ detail.ejs ที่รอรับอยู่
    res.render('chef/detail', { menu: menu });
  });
});

app.post("/adjust_order", (req, res) => {
    const order_id = req.body.order_id;
    const new_status = req.body.chef_gived_status; // 'เสร็จสิ้น' หรือ 'ยกเลิก'

    if (!order_id || !new_status) {
        return res.status(400).send("ข้อมูลไม่ครบถ้วน");
    }

    const sql = `UPDATE orders SET order_status = ? WHERE order_id = ?`;
    
    db.run(sql, [new_status, order_id], function(err) {
        if (err) {
            console.error("Update Status Error:", err);
            return res.status(500).send("เกิดข้อผิดพลาดในการอัปเดตสถานะ");
        }
        
        // อัปเดตสำเร็จ ให้กลับไปหน้าแสดงรายการออเดอร์ทั้งหมดของเชฟ
        return res.send(`
          <script>
            alert('เปลี่ยนสถานะเสร็จสิ้น');
            window.location.href = '/chef/orders';
          </script>
        `);
  });
});

// ==========================================
// PROMPT-PAY (customer และ service ใช้ร่วมกัน)
// ==========================================

// หน้า QR พร้อมเพย์ + ยอดรวมของคำสั่งซื้อ
function promptPayPage(role) {
  return (req, res) => {
    if (!req.session.user_id || req.session.role !== role) {
      return res.redirect("/");
    }

    const pending = req.session.pending_payment;
    if (!pending || pending.role !== role) {
      return res.redirect(`/${role}/home`);
    }

    // ซื้อแพ็กเกจเวลา (customer) -> ยอดรวม = ราคาแพ็กเกจ
    if (pending.type === 'package') {
      const packageId = req.session.package;
      if (!packageId) return res.redirect('/customer/buy_time');

      return db.get(`SELECT price FROM product WHERE product_id = ? AND is_active = 1`, [packageId], (err, product) => {
        if (err || !product) {
          console.log(err);
          return res.redirect('/customer/buy_time');
        }
        return res.render('prompt_pay', {
          total: product.price,
          backUrl: '/customer/payment',
          confirmUrl: `/${role}/confirm-payment`
        });
      });
    }

    // ซื้อสินค้าในตะกร้า -> ยอดรวม = ผลรวมราคาสินค้าทุกชิ้น
    const cart = readCart(req);
    if (cart.length === 0) return res.redirect(`/${role}/home`);

    calcCartTotal(cart, (err, totalAmount) => {
      if (err) {
        console.error(err);
        return res.status(500).send("เกิดข้อผิดพลาดในการดึงข้อมูลสินค้า");
      }
      if (totalAmount <= 0) return res.redirect(`/${role}/cart`);

      return res.render('prompt_pay', {
        total: totalAmount,
        backUrl: `/${role}/cart`,
        confirmUrl: `/${role}/confirm-payment`
      });
    });
  };
}

// กดปุ่ม "ยืนยันการชำระเงิน" -> บันทึกออเดอร์ + payment ลง Database
function confirmPromptPay(role) {
  return (req, res) => {
    if (!req.session.user_id || req.session.role !== role) {
      return res.redirect("/");
    }

    const pending = req.session.pending_payment;
    if (!pending || pending.role !== role) {
      return res.redirect(`/${role}/home`);
    }

    if (pending.type === 'package') {
      return processPackagePayment(req, res, PROMPTPAY);
    }
    return processCartPayment(req, res, PROMPTPAY, `/${role}/home`);
  };
}

app.get("/customer/prompt-pay", promptPayPage('customer'));
app.post("/customer/confirm-payment", confirmPromptPay('customer'));

app.get("/service/prompt-pay", promptPayPage('service'));
app.post("/service/confirm-payment", confirmPromptPay('service'));

app.listen(port, () => {
  console.log(`Starting server at port ${port} link http://localhost:${port}`);
});