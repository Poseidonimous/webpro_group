const express = require("express");
const path = require("path");
const cors = require('cors');
const port = 3000;
const sqlite3 = require('sqlite3').verbose();

const app = express();

// Connect to SQLite database
//let db = new sqlite3.Database('your-db-filename.db', (err) => {    
//  if (err) {
//      return console.error(err.message);
//  }
//  console.log('Connected to the SQlite database.');
//});

app.use(express.static('public'));
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.get("/login", (req, res) => {
  res.render('customer_login');
});

app.post("/login", (req,res)=>{
    res.redirect('/');
});

app.get("/register", (req, res) => {
  res.render('customer_register');
});

app.post("/register", (req, res) => {
  res.render('customer_register');
});

app.get("/home", (req, res) => {
  res.render('customer_home');
});

app.get("/order", (req, res) => {
  res.render('customer_home');
});

app.get("/buy_time", (req, res) => {
  res.render('customer_buytime');
});

app.get("/payment", (req,res)=>{
  res.render('payment')
});

app.get("/history", (req, res) => {
  res.render('customer_home');
});

app.listen(port, () => {
  console.log(`Starting server at port ${port}`);
});