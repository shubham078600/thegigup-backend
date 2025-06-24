import crypto from 'crypto';
import { setCache, getCache, deleteCache } from './redis.js';
import transporter from '../nodemailer.config.js';
import { getEmailVerificationOTPTemplate } from './emailTemplates.js';
import prisma from '../prisma.config.js';
// Generate 6-digit OTP
export const generateEmailVerificationOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// Store email verification OTP in Redis
export const storeEmailVerificationOTP = async (email, otp) => {
    const key = `email_verification_otp:${email}`;
    const data = {
        otp,
        email,
        createdAt: new Date().toISOString(),
        attempts: 0,
        verified: false
    };
    
    // Store for 10 minutes (600 seconds)
    await setCache(key, data, 600);
    return key;
};

// Verify email verification OTP
export const verifyEmailVerificationOTP = async (email, otp) => {
    const key = `email_verification_otp:${email}`;
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
    
    // Mark as verified and extend cache
    data.verified = true;
    data.verifiedAt = new Date().toISOString();
    await setCache(key, data, 1800); // Extend to 30 minutes after verification
    
    return { valid: true, data };
};

// Check if email OTP is verified
export const isEmailOTPVerified = async (email) => {
    const key = `email_verification_otp:${email}`;
    const data = await getCache(key);
    
    return data && data.verified === true;
};

// Delete email verification OTP
export const invalidateEmailVerificationOTP = async (email) => {
    const key = `email_verification_otp:${email}`;
    await deleteCache(key);
};

// Send email verification OTP
export const sendEmailVerificationOTP = async (email, otp) => {
    try {
        const emailTemplate = getEmailVerificationOTPTemplate(otp, email);
        
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
                    console.error('Email verification OTP send error:', error);
                    reject(error);
                } else {
                    console.log('Email verification OTP sent:', info.response);
                    resolve(info);
                }
            });
        });
    } catch (error) {
        console.error('Send email verification OTP error:', error);
        throw error;
    }
};

// Check if email is already registered
export const checkEmailRegistration = async (email) => {
    try {
        const user = await prisma.user.findUnique({
            where: { email },
            include: {
                client: true,
                freelancer: true
            }
        });

        if (!user) {
            return { registered: false };
        }

        let userType = '';
        if (user.role === 'CLIENT') {
            userType = 'client';
        } else if (user.role === 'FREELANCER') {
            userType = 'freelancer';
        } else {
            userType = user.role.toLowerCase();
        }

        return {
            registered: true,
            userType: userType,
            message: `Email is already registered as ${userType}`
        };
    } catch (error) {
        console.error('Check email registration error:', error);
        throw error;
    }
};