// utils/passwordReset.js
import crypto from 'crypto';
import { setCache, getCache, deleteCache } from './redis.js';
import transporter from '../nodemailer.config.js';
import { getOTPEmailTemplate } from './emailTemplates.js';

// Generate 6-digit OTP
export const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// Store OTP in Redis with expiration
export const storeOTP = async (email, otp, userType) => {
    const key = `password_reset_otp:${userType}:${email}`;
    const data = {
        otp,
        email,
        userType,
        createdAt: new Date().toISOString(),
        attempts: 0,
        verified: false
    };
    
    // Store for 10 minutes (600 seconds)
    await setCache(key, data, 600);
    return key;
};

// Verify OTP
export const verifyOTP = async (email, otp, userType) => {
    const key = `password_reset_otp:${userType}:${email}`;
    const data = await getCache(key);
    
    if (!data) {
        return { valid: false, error: 'OTP expired or invalid' };
    }
    
    if (data.otp !== otp) {
        // Increment failed attempts
        data.attempts = (data.attempts || 0) + 1;
        
        if (data.attempts >= 3) {
            await deleteCache(key);
            return { valid: false, error: 'Too many failed attempts. Please request a new OTP.' };
        }
        
        await setCache(key, data, 600);
        return { valid: false, error: 'Invalid OTP' };
    }
    
    // Mark as verified but keep in cache for password reset
    data.verified = true;
    data.verifiedAt = new Date().toISOString();
    await setCache(key, data, 900); // Extend to 15 minutes after verification
    
    return { valid: true, data };
};

// Check if OTP is verified
export const isOTPVerified = async (email, userType) => {
    const key = `password_reset_otp:${userType}:${email}`;
    const data = await getCache(key);
    
    return data && data.verified === true;
};

// Delete OTP after password reset
export const invalidateOTP = async (email, userType) => {
    const key = `password_reset_otp:${userType}:${email}`;
    await deleteCache(key);
};

// Send OTP email
export const sendOTPEmail = async (email, userName, otp, userType) => {
    try {
        const emailTemplate = getOTPEmailTemplate(otp, userName, userType);
        
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: emailTemplate.subject,
            text: emailTemplate.text,
            html: emailTemplate.html
        };

        return new Promise((resolve, reject) => {
            transporter.sendMail(mailOptions, (error, info) => {
                if (error) {
                    console.error('Email send error:', error);
                    reject(error);
                } else {
                    console.log('OTP email sent:', info.response);
                    resolve(info);
                }
            });
        });
    } catch (error) {
        console.error('Send OTP email error:', error);
        throw error;
    }
};