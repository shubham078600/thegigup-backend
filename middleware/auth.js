import jwt from 'jsonwebtoken';
import prisma from '../prisma.config.js';

export const authenticateToken = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Access denied. No token provided.'
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Check if user exists and is active
        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                email: true,
                role: true,
                isActive: true,
                name: true
            }
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid token. User not found.'
            });
        }

        // Check if user account is suspended
        if (!user.isActive) {
            return res.status(403).json({
                success: false,
                message: 'Your account has been suspended. Please contact support for assistance.',
                errorCode: 'ACCOUNT_SUSPENDED'
            });
        }

        req.user = decoded;
        req.userInfo = user; // Add user info for easy access
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                success: false,
                message: 'Invalid token'
            });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                message: 'Token expired'
            });
        }
        
        console.error('Authentication error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
};

// New middleware specifically for freelancer actions
export const checkFreelancerActive = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        
        const freelancer = await prisma.freelancer.findUnique({
            where: { userId },
            include: {
                user: {
                    select: {
                        isActive: true,
                        name: true
                    }
                }
            }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer profile not found'
            });
        }

        if (!freelancer.user.isActive) {
            return res.status(403).json({
                success: false,
                message: 'Your account has been suspended. You cannot perform this action.',
                errorCode: 'ACCOUNT_SUSPENDED'
            });
        }

        req.freelancer = freelancer;
        next();
    } catch (error) {
        console.error('Freelancer check error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
};

// New middleware specifically for client actions
export const checkClientActive = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        
        const client = await prisma.client.findUnique({
            where: { userId },
            include: {
                user: {
                    select: {
                        isActive: true,
                        name: true
                    }
                }
            }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client profile not found'
            });
        }

        if (!client.user.isActive) {
            return res.status(403).json({
                success: false,
                message: 'Your account has been suspended. You cannot perform this action.',
                errorCode: 'ACCOUNT_SUSPENDED'
            });
        }

        req.client = client;
        next();
    } catch (error) {
        console.error('Client check error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
};