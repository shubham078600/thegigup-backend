import jwt from 'jsonwebtoken';
import prisma from '../prisma.config.js';

export const authenticateAdmin = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Access denied. No token provided.'
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Check if user exists and is admin
        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            include: {
                admin: true
            }
        });

        if (!user || user.role !== 'ADMIN' || !user.admin) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Admin privileges required.'
            });
        }

        if (!user.isActive) {
            return res.status(403).json({
                success: false,
                message: 'Account suspended. Contact support.'
            });
        }

        req.user = decoded;
        req.admin = user.admin;
        next();
    } catch (error) {
        res.status(401).json({
            success: false,
            message: 'Invalid token'
        });
    }
};

export const requirePermission = (requiredPermissions) => {
    return (req, res, next) => {
        const adminPermissions = req.admin.permissions;
        
        // Super admin has all permissions
        if (adminPermissions.includes('SUPER_ADMIN')) {
            return next();
        }

        // Check if admin has required permission
        const hasPermission = requiredPermissions.some(permission => 
            adminPermissions.includes(permission)
        );

        if (!hasPermission) {
            return res.status(403).json({
                success: false,
                message: 'Insufficient permissions'
            });
        }

        next();
    };
};