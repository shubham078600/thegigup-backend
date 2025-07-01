import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.in',
  port: 465, // or 587 for TLS
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.APP_PASS,
  },
});


export default transporter;


