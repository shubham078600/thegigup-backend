import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../prisma.config.js';
import { authenticateAdmin, requirePermission } from '../middleware/adminAuth.js';
import { setCache, getCache, deleteCache } from '../utils/redis.js';

export const adminRouter = Router();

// Admin Login
adminRouter.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find admin user
        const user = await prisma.user.findUnique({
            where: { email },
            include: {
                admin: true
            }
        });

        if (!user || user.role !== 'ADMIN' || !user.admin) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        if (!user.isActive) {
            return res.status(403).json({
                success: false,
                message: 'Account suspended. Contact support.'
            });
        }

        // Verify password
        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Generate token
        const token = jwt.sign(
            { userId: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                token,
                admin: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    permissions: user.admin.permissions
                }
            }
        });

    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Get Dashboard Stats
adminRouter.get('/dashboard', authenticateAdmin, async (req, res) => {
    try {
        const cacheKey = 'admin:dashboard:stats';
        
        // Check cache
        const cachedData = await getCache(cacheKey);
        if (cachedData) {
            return res.status(200).json({
                success: true,
                data: cachedData
            });
        }

        const [
            totalUsers,
            totalFreelancers,
            totalClients,
            totalProjects,
            completedProjects,
            openProjects,
            pendingReports,
            activeUsers,
            recentUsers,
            recentProjects
        ] = await Promise.all([
            prisma.user.count(),
            prisma.freelancer.count(),
            prisma.client.count(),
            prisma.project.count(),
            prisma.project.count({ where: { status: 'COMPLETED' } }),
            prisma.project.count({ where: { status: 'OPEN' } }),
            prisma.report.count({ where: { status: 'PENDING' } }),
            prisma.user.count({ where: { isActive: true } }),
            prisma.user.findMany({
                orderBy: { createdAt: 'desc' },
                take: 5,
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                    createdAt: true
                }
            }),
            prisma.project.findMany({
                orderBy: { createdAt: 'desc' },
                take: 5,
                include: {
                    client: {
                        include: {
                            user: {
                                select: {
                                    name: true
                                }
                            }
                        }
                    }
                }
            })
        ]);

        const dashboardData = {
            stats: {
                totalUsers,
                totalFreelancers,
                totalClients,
                totalProjects,
                completedProjects,
                openProjects,
                pendingReports,
                activeUsers,
                successRate: totalProjects > 0 ? ((completedProjects / totalProjects) * 100).toFixed(1) : 0
            },
            recentActivity: {
                recentUsers,
                recentProjects: recentProjects.map(project => ({
                    id: project.id,
                    title: project.title,
                    status: project.status,
                    clientName: project.client.user.name,
                    createdAt: project.createdAt
                }))
            }
        };

        // Cache for 5 minutes
        await setCache(cacheKey, dashboardData, 300);

        res.status(200).json({
            success: true,
            data: dashboardData
        });

    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Get All Users with Filtering
adminRouter.get('/users', authenticateAdmin, requirePermission(['MODERATOR', 'SUPPORT']), async (req, res) => {
    try {
        const {
            role,
            isActive,
            search,
            page = 1,
            limit = 20
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const whereClause = {};

        if (role && role !== 'all') {
            whereClause.role = role.toUpperCase();
        }

        if (isActive !== undefined) {
            whereClause.isActive = isActive === 'true';
        }

        if (search) {
            whereClause.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } }
            ];
        }

        const [users, totalUsers] = await Promise.all([
            prisma.user.findMany({
                where: whereClause,
                include: {
                    freelancer: true,
                    client: true,
                    admin: true
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: parseInt(limit)
            }),
            prisma.user.count({ where: whereClause })
        ]);

        const userData = users.map(user => ({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            isActive: user.isActive,
            profileImage: user.profileImage,
            location: user.location,
            createdAt: user.createdAt,
            ...(user.freelancer && {
                freelancerData: {
                    projectsCompleted: user.freelancer.projectsCompleted,
                    ratings: user.freelancer.ratings,
                    isVerified: user.freelancer.isVerified
                }
            }),
            ...(user.client && {
                clientData: {
                    projectsPosted: user.client.projectsPosted,
                    companyName: user.client.companyName,
                    isVerified: user.client.isVerified
                }
            }),
            ...(user.admin && {
                adminData: {
                    permissions: user.admin.permissions
                }
            })
        }));

        res.status(200).json({
            success: true,
            data: {
                users: userData,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: totalUsers,
                    pages: Math.ceil(totalUsers / parseInt(limit))
                }
            }
        });

    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Suspend/Unsuspend User
adminRouter.patch('/users/:userId/toggle-status', authenticateAdmin, requirePermission(['MODERATOR']), async (req, res) => {
    try {
        const { userId } = req.params;
        const { reason } = req.body;

        const user = await prisma.user.findUnique({
            where: { id: userId }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Prevent suspending other admins (unless super admin)
        if (user.role === 'ADMIN' && !req.admin.permissions.includes('SUPER_ADMIN')) {
            return res.status(403).json({
                success: false,
                message: 'Cannot suspend admin users'
            });
        }

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: {
                isActive: !user.isActive
            }
        });

        // Clear user cache
        await deleteCache(`user:${userId}`);

        res.status(200).json({
            success: true,
            message: `User ${updatedUser.isActive ? 'activated' : 'suspended'} successfully`,
            data: {
                userId: updatedUser.id,
                isActive: updatedUser.isActive
            }
        });

    } catch (error) {
        console.error('Toggle user status error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Verify Freelancer/Client
adminRouter.patch('/users/:userId/verify', authenticateAdmin, requirePermission(['MODERATOR']), async (req, res) => {
    try {
        const { userId } = req.params;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: {
                freelancer: true,
                client: true
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        let updatedData = {};

        if (user.freelancer) {
            updatedData = await prisma.freelancer.update({
                where: { userId },
                data: { isVerified: !user.freelancer.isVerified }
            });
        } else if (user.client) {
            updatedData = await prisma.client.update({
                where: { userId },
                data: { isVerified: !user.client.isVerified }
            });
        } else {
            return res.status(400).json({
                success: false,
                message: 'User is not a freelancer or client'
            });
        }

        res.status(200).json({
            success: true,
            message: `${user.role.toLowerCase()} ${updatedData.isVerified ? 'verified' : 'unverified'} successfully`,
            data: {
                userId,
                isVerified: updatedData.isVerified
            }
        });

    } catch (error) {
        console.error('Verify user error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Get All Projects
adminRouter.get('/projects', authenticateAdmin, requirePermission(['MODERATOR', 'SUPPORT']), async (req, res) => {
    try {
        const {
            status,
            search,
            page = 1,
            limit = 20
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const whereClause = {};

        if (status && status !== 'all') {
            whereClause.status = status.toUpperCase();
        }

        if (search) {
            whereClause.OR = [
                { title: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } }
            ];
        }

        const [projects, totalProjects] = await Promise.all([
            prisma.project.findMany({
                where: whereClause,
                include: {
                    client: {
                        include: {
                            user: {
                                select: {
                                    name: true,
                                    email: true
                                }
                            }
                        }
                    },
                    freelancer: {
                        include: {
                            user: {
                                select: {
                                    name: true,
                                    email: true
                                }
                            }
                        }
                    },
                    applications: {
                        select: {
                            id: true
                        }
                    }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: parseInt(limit)
            }),
            prisma.project.count({ where: whereClause })
        ]);

        const projectData = projects.map(project => ({
            id: project.id,
            title: project.title,
            description: project.description,
            status: project.status,
            skillsRequired: project.skillsRequired,
            budget: {
                min: project.budgetMin,
                max: project.budgetMax
            },
            duration: project.duration,
            isFeatured: project.isFeatured,
            applicationsCount: project.applications.length,
            client: {
                name: project.client.user.name,
                email: project.client.user.email,
                company: project.client.companyName
            },
            freelancer: project.freelancer ? {
                name: project.freelancer.user.name,
                email: project.freelancer.user.email
            } : null,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt
        }));

        res.status(200).json({
            success: true,
            data: {
                projects: projectData,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: totalProjects,
                    pages: Math.ceil(totalProjects / parseInt(limit))
                }
            }
        });

    } catch (error) {
        console.error('Get projects error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Feature/Unfeature Project
adminRouter.patch('/projects/:projectId/toggle-featured', authenticateAdmin, requirePermission(['MODERATOR']), async (req, res) => {
    try {
        const { projectId } = req.params;

        const project = await prisma.project.findUnique({
            where: { id: projectId }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found'
            });
        }

        const updatedProject = await prisma.project.update({
            where: { id: projectId },
            data: {
                isFeatured: !project.isFeatured
            }
        });

        // Clear featured projects cache
        await deleteCache('public:featured:projects');

        res.status(200).json({
            success: true,
            message: `Project ${updatedProject.isFeatured ? 'featured' : 'unfeatured'} successfully`,
            data: {
                projectId: updatedProject.id,
                isFeatured: updatedProject.isFeatured
            }
        });

    } catch (error) {
        console.error('Toggle project featured error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Create Super Admin (Only for initial setup)
adminRouter.post('/create-super-admin', async (req, res) => {
    try {
        // Check if any super admin exists
        const existingSuperAdmin = await prisma.admin.findFirst({
            where: {
                permissions: {
                    has: 'SUPER_ADMIN'
                }
            }
        });

        if (existingSuperAdmin) {
            return res.status(400).json({
                success: false,
                message: 'Super admin already exists'
            });
        }

        const { name, email, password } = req.body;

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Create user and admin in transaction
        const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
                data: {
                    name,
                    email,
                    password: hashedPassword,
                    role: 'ADMIN'
                }
            });

            const admin = await tx.admin.create({
                data: {
                    userId: user.id,
                    permissions: ['SUPER_ADMIN']
                }
            });

            return { user, admin };
        });

        res.status(201).json({
            success: true,
            message: 'Super admin created successfully',
            data: {
                id: result.user.id,
                name: result.user.name,
                email: result.user.email,
                permissions: result.admin.permissions
            }
        });

    } catch (error) {
        console.error('Create super admin error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});