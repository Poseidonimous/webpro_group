const mysql = require('mysql2');
const conn = mysql.createConnection({
    host : "webdev.it.kmitl.ac.th",
    user : "s67070035",
    password : "DCBP269EI215IV",
    database : "s67070035"
});

conn.connect(error => {
    if(error) throw error;
    console.log("Successful, Database Connected.");
});

module.exports = conn;