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


// ALL PATH
app.get("/login", (req, res) => {
  res.render('login');
});

app.post("/login", (req,res)=>{
    res.redirect('/');
});

app.get("/register", (req, res) => {
  res.render('register');
});

app.post("/register", (req, res) => {
  res.render('customer/register');
});

// customer PATH
app.get("/customer/home", (req, res) => {
  res.render('customer/home');
});

app.get("/customer/order", (req, res) => {
  res.render('customer/menu');
});

app.get("/customer/cart", (req, res) => {
  res.render('customer/cart');
});

app.get("/customer/buy_time", (req, res) => {
  res.render('customer/buytime');
});

app.get("/customer/payment", (req,res)=>{
  res.render('customer/payment')
});

app.get("/customer/history", (req, res) => {
  res.render('customer/history');
});

// Service Path
app.get("/service/home", (req, res) => {
  res.render('service/home');
});

app.get("/service/order", (req, res) => {
  res.render('service/menu');
});

app.get("/service/cart", (req, res) => {
  res.render('service/cart');
});

app.get("/service/history", (req, res) => {
  res.render('service/history');
});

// Chef Path
app.get("/chef/home", (req, res) => {
  res.render('chef/home');
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
  console.log(`Starting server at port ${port}`);
});