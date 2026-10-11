const express = require("express");
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require("path");
const cors = require('cors');
const port = 3000;
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
  const package = req.session.package;
  const order_id = 'ORD' + Date.now();
  const user_id = req.session.user_id;
  
  // แปลง Date เป็นรูปแบบ YYYY-MM-DD HH:MM:SS
  const d = new Date();
  const now = d.getFullYear() + '-' + 
              String(d.getMonth() + 1).padStart(2, '0') + '-' + 
              String(d.getDate()).padStart(2, '0') + ' ' + 
              String(d.getHours()).padStart(2, '0') + ':' + 
              String(d.getMinutes()).padStart(2, '0') + ':' + 
              String(d.getSeconds()).padStart(2, '0');

  const price_sql = `SELECT * FROM product WHERE product_id = ? AND is_active = 1`;
  db.get(price_sql, [package], function(err, product) {
    if(err || !product) {
      console.log(err);
      return res.redirect("/customer/buy_time");
    }
    const order_sql = `INSERT INTO orders(order_id, user_id, total_amount, order_status, created_at) VALUES (?, ?, ?, ?, ?)`;
    db.run(order_sql, [order_id, user_id, product.price, 'success', now], function(error) {
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

            return res.send(`
              <script>
                alert('ซื้อเวลาสำเร็จ');
                window.location.href = '/customer/home';
              </script>
            `);
          });
        });
      });
    });
  });
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
    // 1. อ่านวิธีจ่ายเงินจาก Form
    const paymentMethod = req.body.payment_method || 'promptpay';

    // 2. อ่านข้อมูล Cart จาก Cookie
    let cart = [];
    if (req.cookies.cart) {
        try {
            cart = JSON.parse(req.cookies.cart);
        } catch (e) {
            cart = [];
        }
    }

    // ถ้าไม่มีของในตะกร้าให้เด้งกลับไปหน้าแรก
    if (cart.length === 0) {
        return res.redirect('/customer/home');
    }

    // 3. กำหนดค่าตัวแปรเบื้องต้น
    // สมมติว่าดึง user_id จาก Session ของคนที่ Login เข้ามา (ถ้าคุณใช้ req.session)
    const userId = req.session.user_id || 1; // ใส่ 1 ไว้เป็นค่าเริ่มต้นกัน Error ตอนทดสอบ
    const orderId = "ORD" + Date.now(); // สร้างรหัสออเดอร์จากเวลาปัจจุบัน

    // 4. ดึงราคาจาก Database เพื่อนำมาคำนวณ
    const productIds = cart.map(item => item.product_id).join(',');
    
    // ค้นหาสินค้าทั้งหมดที่มีในตะกร้าจากตาราง product
    db.all(`SELECT product_id, price FROM product WHERE product_id IN (${productIds})`, [], (err, products) => {
        if (err) {
            console.error(err);
            return res.status(500).send("เกิดข้อผิดพลาดในการดึงข้อมูลสินค้า");
        }

        let totalAmount = 0;
        const orderDetails = [];

        // คำนวณราคารวมและยอดแยกแต่ละชิ้น
        cart.forEach(item => {
            const product = products.find(p => p.product_id == item.product_id);
            if (product) {
                const unitPrice = product.price;
                const subtotal = unitPrice * item.quantity;
                totalAmount += subtotal;

                orderDetails.push({
                    productId: item.product_id,
                    quantity: item.quantity,
                    unitPrice: unitPrice,
                    subtotal: subtotal
                });
            }
        });

        // ==========================================
        // เริ่มบันทึกลง Database
        // ==========================================
        db.serialize(() => {
            // ตาราง orders: บันทึกข้อมูลหลักของคำสั่งซื้อ กำหนดสถานะเป็น 'pending'
            db.run(`INSERT INTO orders (order_id, user_id, total_amount, order_status) VALUES (?, ?, ?, 'pending')`, 
                [orderId, userId, totalAmount], function(err) {
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

                // ตาราง payment: บันทึกข้อมูลการชำระเงิน
                db.run(`INSERT INTO payment (order_id, payment_method, amount) VALUES (?, ?, ?)`, 
                    [orderId, paymentMethod, totalAmount], function(err) {
                    if (err) {
                        console.error("Error inserting payment:", err);
                        return res.status(500).send("บันทึกการชำระเงินไม่สำเร็จ");
                    }

                    // เมื่อบันทึกสำเร็จทั้งหมด ให้ลบ Cookie ตะกร้าสินค้าออก
                    res.clearCookie('cart');
                    
                    // เปลี่ยนหน้าไปยังหน้ารายการสั่งซื้อของลูกค้า
                    return res.send(`
                      <script>
                        alert('ซื้อสินค้าสำเร็จ');
                        window.location.href = '/customer/home';
                      </script>
                    `);
                });
            });
        });
    });
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

app.get("/service/order", (req, res) => {
  res.render('service/menu');
});

app.get("/service/cart", (req, res) => {
  res.render('service/cart');
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

app.get("/chef/orders", (req, res) => {
  res.render('chef/order');
});

app.get("/chef/orders/:id", (req, res) => {
  res.render('chef/detail');
});

app.get("/chef/history", (req, res) => {
  res.render('chef/history');
});

app.listen(port, () => {
  console.log(`Starting server at port ${port} link http://localhost:${port}`);
});