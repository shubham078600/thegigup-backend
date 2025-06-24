// utils/emailTemplates.js
export const getOTPEmailTemplate = (otp, userName, userType) => {
    return {
        subject: `Password Reset OTP - TheGigUp`,
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    .container { max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif; }
                    .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; }
                    .content { padding: 30px; background-color: #f9f9f9; }
                    .otp-box { 
                        background-color: #4F46E5; 
                        color: white; 
                        font-size: 32px; 
                        font-weight: bold; 
                        padding: 20px; 
                        text-align: center; 
                        border-radius: 8px; 
                        margin: 20px 0;
                        letter-spacing: 8px;
                    }
                    .footer { background-color: #374151; color: white; padding: 20px; text-align: center; font-size: 12px; }
                    .warning { background-color: #FEF3C7; border-left: 4px solid #F59E0B; padding: 15px; margin: 20px 0; }
                    .security-tip { background-color: #DBEAFE; border-left: 4px solid #3B82F6; padding: 15px; margin: 20px 0; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>🔐 Password Reset OTP</h1>
                    </div>
                    <div class="content">
                        <h2>Hello ${userName},</h2>
                        <p>We received a request to reset your ${userType.toLowerCase()} account password. Use the OTP below to verify your identity:</p>
                        
                        <div class="otp-box">
                            ${otp}
                        </div>
                        
                        <div class="warning">
                            <strong>⚠️ Important:</strong>
                            <ul>
                                <li>This OTP will expire in <strong>10 minutes</strong></li>
                                <li>You have <strong>3 attempts</strong> to enter the correct OTP</li>
                                <li>If you didn't request this reset, please ignore this email</li>
                            </ul>
                        </div>
                        
                        <div class="security-tip">
                            <strong>🛡️ Security Tip:</strong>
                            <p>Never share this OTP with anyone. TheGigUp will never ask for your OTP via phone or email.</p>
                        </div>
                        
                        <p>If you continue to have problems, please contact our support team.</p>
                        
                        <p>Best regards,<br>The TheGigUp Team</p>
                    </div>
                    <div class="footer">
                        <p>&copy; 2024 TheGigUp. All rights reserved.</p>
                        <p>This is an automated email. Please do not reply to this message.</p>
                    </div>
                </div>
            </body>
            </html>
        `,
        text: `
            Hello ${userName},
            
            We received a request to reset your ${userType.toLowerCase()} account password.
            
            Your OTP for password reset is: ${otp}
            
            This OTP will expire in 10 minutes.
            You have 3 attempts to enter the correct OTP.
            
            If you didn't request this reset, please ignore this email.
            
            Best regards,
            The TheGigUp Team
        `
    };
};

// Keep the existing password reset email template for confirmation
export const getPasswordResetEmailTemplate = (resetUrl, userName, userType) => {
    return {
        subject: `Reset Your ${userType} Password - TheGigUp`,
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    .container { max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif; }
                    .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; }
                    .content { padding: 30px; background-color: #f9f9f9; }
                    .button { 
                        display: inline-block; 
                        background-color: #4F46E5; 
                        color: white; 
                        padding: 12px 24px; 
                        text-decoration: none; 
                        border-radius: 5px; 
                        margin: 20px 0; 
                    }
                    .footer { background-color: #374151; color: white; padding: 20px; text-align: center; font-size: 12px; }
                    .warning { background-color: #FEF3C7; border-left: 4px solid #F59E0B; padding: 15px; margin: 20px 0; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>Password Reset Request</h1>
                    </div>
                    <div class="content">
                        <h2>Hello ${userName},</h2>
                        <p>We received a request to reset your ${userType.toLowerCase()} account password. Click the button below to reset your password:</p>
                        
                        <div style="text-align: center;">
                            <a href="${resetUrl}" class="button">Reset Password</a>
                        </div>
                        
                        <p>Or copy and paste this link into your browser:</p>
                        <p style="word-break: break-all; color: #4F46E5;">${resetUrl}</p>
                        
                        <div class="warning">
                            <strong>⚠️ Important:</strong>
                            <ul>
                                <li>This link will expire in <strong>15 minutes</strong></li>
                                <li>If you didn't request this reset, please ignore this email</li>
                                <li>For security, never share this link with anyone</li>
                            </ul>
                        </div>
                        
                        <p>If you continue to have problems, please contact our support team.</p>
                        
                        <p>Best regards,<br>The TheGigUp Team</p>
                    </div>
                    <div class="footer">
                        <p>&copy; 2024 TheGigUp. All rights reserved.</p>
                        <p>This is an automated email. Please do not reply to this message.</p>
                    </div>
                </div>
            </body>
            </html>
        `,
        text: `
            Hello ${userName},
            
            We received a request to reset your ${userType.toLowerCase()} account password.
            
            Please click the following link to reset your password:
            ${resetUrl}
            
            This link will expire in 15 minutes.
            
            If you didn't request this reset, please ignore this email.
            
            Best regards,
            The TheGigUp Team
        `
    };
};

export const getEmailVerificationOTPTemplate = (otp, email) => {
    return {
        subject: `Email Verification OTP - TheGigUp`,
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    .container { max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif; }
                    .header { background-color: #10B981; color: white; padding: 20px; text-align: center; }
                    .content { padding: 30px; background-color: #f9f9f9; }
                    .otp-box { 
                        background-color: #10B981; 
                        color: white; 
                        font-size: 32px; 
                        font-weight: bold; 
                        padding: 20px; 
                        text-align: center; 
                        border-radius: 8px; 
                        margin: 20px 0;
                        letter-spacing: 8px;
                    }
                    .footer { background-color: #374151; color: white; padding: 20px; text-align: center; font-size: 12px; }
                    .warning { background-color: #FEF3C7; border-left: 4px solid #F59E0B; padding: 15px; margin: 20px 0; }
                    .security-tip { background-color: #DBEAFE; border-left: 4px solid #3B82F6; padding: 15px; margin: 20px 0; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>📧 Email Verification OTP</h1>
                    </div>
                    <div class="content">
                        <h2>Welcome to TheGigUp!</h2>
                        <p>Please use the OTP below to verify your email address:</p>
                        
                        <div class="otp-box">
                            ${otp}
                        </div>
                        
                        <div class="warning">
                            <strong>⚠️ Important:</strong>
                            <ul>
                                <li>This OTP will expire in <strong>10 minutes</strong></li>
                                <li>You have <strong>3 attempts</strong> to enter the correct OTP</li>
                                <li>If you didn't request this verification, please ignore this email</li>
                            </ul>
                        </div>
                        
                        <div class="security-tip">
                            <strong>🛡️ Security Tip:</strong>
                            <p>Never share this OTP with anyone. TheGigUp will never ask for your OTP via phone or email.</p>
                        </div>
                        
                        <p>After verification, you can complete your account registration.</p>
                        
                        <p>Best regards,<br>The TheGigUp Team</p>
                    </div>
                    <div class="footer">
                        <p>&copy; 2024 TheGigUp. All rights reserved.</p>
                        <p>This is an automated email. Please do not reply to this message.</p>
                    </div>
                </div>
            </body>
            </html>
        `,
        text: `
            Welcome to TheGigUp!
            
            Please use the OTP below to verify your email address: ${otp}
            
            This OTP will expire in 10 minutes.
            You have 3 attempts to enter the correct OTP.
            
            If you didn't request this verification, please ignore this email.
            
            Best regards,
            The TheGigUp Team
        `
    };
};