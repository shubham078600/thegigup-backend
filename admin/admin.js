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

// Update Project Status (Approve/Reject)
adminRouter.patch('/projects/:projectId/status', authenticateAdmin, requirePermission(['MODERATOR']), async (req, res) => {
    try {
        const { projectId } = req.params;
        const { action, rejectedReason } = req.body;

        // Validate input
        if (!action || !['approve', 'reject'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'Action must be either "approve" or "reject"'
            });
        }

        // If rejecting, reason is required
        if (action === 'reject' && !rejectedReason) {
            return res.status(400).json({
                success: false,
                message: 'Rejection reason is required when rejecting a project'
            });
        }

        if (rejectedReason && rejectedReason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Rejection reason must be at least 10 characters long'
            });
        }

        // Find the project
        const project = await prisma.project.findUnique({
            where: { id: projectId },
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
                }
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found'
            });
        }

        // Check if project is in ADMIN_VERIFICATION status
        if (project.status !== 'ADMIN_VERIFICATION') {
            return res.status(400).json({
                success: false,
                message: `Cannot update status. Project is currently ${project.status}. Only projects under ADMIN_VERIFICATION can be approved or rejected.`
            });
        }

        // Prepare update data
        const updateData = {
            updatedAt: new Date()
        };

        if (action === 'approve') {
            updateData.status = 'OPEN';
            updateData.rejectedReason = null; // Clear any previous rejection reason
        } else {
            updateData.status = 'CANCELLED';
            updateData.rejectedReason = rejectedReason.trim();
        }

        // Update the project
        const updatedProject = await prisma.project.update({
            where: { id: projectId },
            data: updateData,
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
                }
            }
        });

        // Clear relevant caches
        await Promise.all([
            deleteCache('admin:dashboard:stats'),
            deleteCache('public:projects:recent'),
            deleteCache('public:featured:projects'),
            deleteCache(`project:${projectId}`),
            deleteCache(`client:projects:${project.clientId}`),
            deleteCache(`client:dashboard:${project.client.userId}`)
        ]);

        // Log admin action
        console.log(`Admin ${req.admin.name} (${req.admin.email}) ${action === 'approve' ? 'approved' : 'rejected'} project ${projectId} - ${project.title}`);

        res.status(200).json({
            success: true,
            message: `Project ${action === 'approve' ? 'approved' : 'rejected'} successfully`,
            data: {
                projectId: updatedProject.id,
                title: updatedProject.title,
                status: updatedProject.status,
                action: action,
                rejectedReason: updatedProject.rejectedReason,
                client: {
                    name: updatedProject.client.user.name,
                    email: updatedProject.client.user.email
                },
                updatedAt: updatedProject.updatedAt,
                adminAction: {
                    performedBy: req.admin.name,
                    performedAt: new Date()
                }
            }
        });

    } catch (error) {
        console.error('Update project status error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Get Projects Pending Admin Verification
adminRouter.get('/projects/pending-verification', authenticateAdmin, requirePermission(['MODERATOR', 'SUPPORT']), async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            search,
            sortBy = 'oldest' // oldest, newest, budget-high, budget-low
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const whereClause = {
            status: 'ADMIN_VERIFICATION'
        };

        if (search) {
            whereClause.OR = [
                { title: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
                { skillsRequired: { hasSome: [search] } }
            ];
        }

        // Determine sort order
        let orderBy = { createdAt: 'asc' }; // Default: oldest first (fairness)
        
        switch (sortBy) {
            case 'newest':
                orderBy = { createdAt: 'desc' };
                break;
            case 'budget-high':
                orderBy = { budgetMax: 'desc' };
                break;
            case 'budget-low':
                orderBy = { budgetMin: 'asc' };
                break;
            default:
                orderBy = { createdAt: 'asc' };
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
                                    email: true,
                                    profileImage: true,
                                    location: true,
                                    createdAt: true
                                }
                            }
                        }
                    }
                },
                orderBy,
                skip,
                take: parseInt(limit)
            }),
            prisma.project.count({ where: whereClause })
        ]);

        const projectData = projects.map(project => {
            const waitingDays = Math.floor((new Date() - new Date(project.createdAt)) / (1000 * 60 * 60 * 24));
            
            return {
                id: project.id,
                title: project.title,
                description: project.description.length > 200 ? 
                    project.description.substring(0, 200) + '...' : 
                    project.description,
                skillsRequired: project.skillsRequired,
                budget: {
                    min: project.budgetMin,
                    max: project.budgetMax,
                    display: project.budgetMin && project.budgetMax ? 
                        `$${project.budgetMin.toLocaleString()} - $${project.budgetMax.toLocaleString()}` : 
                        'Budget not specified'
                },
                duration: project.duration || 'Not specified',
                status: project.status,
                client: {
                    id: project.client.id,
                    name: project.client.user.name,
                    email: project.client.user.email,
                    profileImage: project.client.user.profileImage,
                    location: project.client.user.location,
                    companyName: project.client.companyName,
                    isVerified: project.client.isVerified,
                    memberSince: project.client.user.createdAt
                },
                waitingTime: {
                    days: waitingDays,
                    display: waitingDays === 0 ? 'Today' : 
                            waitingDays === 1 ? '1 day ago' : 
                            `${waitingDays} days ago`,
                    urgency: waitingDays >= 7 ? 'high' : 
                            waitingDays >= 3 ? 'medium' : 'low'
                },
                createdAt: project.createdAt,
                priority: waitingDays >= 7 ? 'high' : 
                         waitingDays >= 3 ? 'medium' : 'normal'
            };
        });

        res.status(200).json({
            success: true,
            data: {
                projects: projectData,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: totalProjects,
                    pages: Math.ceil(totalProjects / parseInt(limit)),
                    hasNext: (parseInt(page) * parseInt(limit)) < totalProjects,
                    hasPrev: parseInt(page) > 1
                },
                stats: {
                    totalPending: totalProjects,
                    highPriority: projectData.filter(p => p.priority === 'high').length,
                    mediumPriority: projectData.filter(p => p.priority === 'medium').length,
                    oldestWaiting: totalProjects > 0 ? projectData[0].waitingTime.days : 0
                },
                sortBy: sortBy
            }
        });

    } catch (error) {
        console.error('Get pending projects error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Bulk Update Project Status (Approve/Reject multiple projects)
adminRouter.patch('/projects/bulk-status', authenticateAdmin, requirePermission(['MODERATOR']), async (req, res) => {
    try {
        const { projectIds, action, rejectedReason } = req.body;

        // Validate input
        if (!projectIds || !Array.isArray(projectIds) || projectIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Project IDs array is required and cannot be empty'
            });
        }

        if (projectIds.length > 50) {
            return res.status(400).json({
                success: false,
                message: 'Cannot update more than 50 projects at once'
            });
        }

        if (!action || !['approve', 'reject'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'Action must be either "approve" or "reject"'
            });
        }

        // If rejecting, reason is required
        if (action === 'reject' && !rejectedReason) {
            return res.status(400).json({
                success: false,
                message: 'Rejection reason is required when rejecting projects'
            });
        }

        if (rejectedReason && rejectedReason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Rejection reason must be at least 10 characters long'
            });
        }

        // Find projects that are in ADMIN_VERIFICATION status
        const projects = await prisma.project.findMany({
            where: {
                id: { in: projectIds },
                status: 'ADMIN_VERIFICATION'
            },
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
                }
            }
        });

        if (projects.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No projects found in ADMIN_VERIFICATION status'
            });
        }

        const validProjectIds = projects.map(p => p.id);
        const invalidProjectIds = projectIds.filter(id => !validProjectIds.includes(id));

        // Prepare update data
        const updateData = {
            updatedAt: new Date()
        };

        if (action === 'approve') {
            updateData.status = 'OPEN';
            updateData.rejectedReason = null;
        } else {
            updateData.status = 'CANCELLED';
            updateData.rejectedReason = rejectedReason.trim();
        }

        // Bulk update projects
        const updateResult = await prisma.project.updateMany({
            where: {
                id: { in: validProjectIds }
            },
            data: updateData
        });

        // Clear caches for all affected projects
        const cacheKeysToDelete = [
            'admin:dashboard:stats',
            'public:projects:recent',
            'public:featured:projects',
            ...validProjectIds.map(id => `project:${id}`),
            ...projects.map(p => `client:projects:${p.clientId}`),
            ...projects.map(p => `client:dashboard:${p.client.userId}`)
        ];

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        // Log admin action
        console.log(`Admin ${req.admin.name} bulk ${action === 'approve' ? 'approved' : 'rejected'} ${updateResult.count} projects`);

        res.status(200).json({
            success: true,
            message: `${updateResult.count} projects ${action === 'approve' ? 'approved' : 'rejected'} successfully`,
            data: {
                action: action,
                updatedCount: updateResult.count,
                totalRequested: projectIds.length,
                invalidCount: invalidProjectIds.length,
                status: action === 'approve' ? 'OPEN' : 'CANCELLED',
                rejectedReason: action === 'reject' ? rejectedReason.trim() : null,
                validProjects: projects.map(p => ({
                    id: p.id,
                    title: p.title,
                    clientName: p.client.user.name
                })),
                invalidProjectIds: invalidProjectIds.length > 0 ? invalidProjectIds : undefined,
                adminAction: {
                    performedBy: req.admin.name,
                    performedAt: new Date()
                }
            }
        });

    } catch (error) {
        console.error('Bulk update project status error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Get Project Details for Admin Review
adminRouter.get('/projects/:projectId/review', authenticateAdmin, requirePermission(['MODERATOR', 'SUPPORT']), async (req, res) => {
    try {
        const { projectId } = req.params;

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: {
                client: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                profileImage: true,
                                location: true,
                                createdAt: true,
                                isActive: true
                            }
                        }
                    }
                },
                applications: {
                    include: {
                        freelancer: {
                            include: {
                                user: {
                                    select: {
                                        name: true,
                                        email: true
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found'
            });
        }

        // Get client's project history for context
        const [clientProjects, clientStats] = await Promise.all([
            prisma.project.findMany({
                where: {
                    clientId: project.clientId,
                    id: { not: projectId }
                },
                select: {
                    id: true,
                    title: true,
                    status: true,
                    budgetMin: true,
                    budgetMax: true,
                    createdAt: true,
                    rejectedReason: true
                },
                orderBy: { createdAt: 'desc' },
                take: 10
            }),
            prisma.project.groupBy({
                by: ['status'],
                where: {
                    clientId: project.clientId
                },
                _count: {
                    status: true
                }
            })
        ]);

        const statusCounts = clientStats.reduce((acc, stat) => {
            acc[stat.status] = stat._count.status;
            return acc;
        }, {});

        const waitingDays = Math.floor((new Date() - new Date(project.createdAt)) / (1000 * 60 * 60 * 24));

        const detailedProject = {
            id: project.id,
            title: project.title,
            description: project.description,
            skillsRequired: project.skillsRequired,
            budget: {
                min: project.budgetMin,
                max: project.budgetMax,
                display: project.budgetMin && project.budgetMax ? 
                    `$${project.budgetMin.toLocaleString()} - $${project.budgetMax.toLocaleString()}` : 
                    'Budget not specified'
            },
            duration: project.duration || 'Not specified',
            status: project.status,
            rejectedReason: project.rejectedReason,
            isFeatured: project.isFeatured,
            applicationsCount: project.applications.length,
            client: {
                id: project.client.id,
                user: project.client.user,
                companyName: project.client.companyName,
                industry: project.client.industry,
                projectsPosted: project.client.projectsPosted,
                ratings: project.client.ratings,
                website: project.client.website,
                isVerified: project.client.isVerified,
                memberSince: project.client.user.createdAt
            },
            clientHistory: {
                totalProjects: clientProjects.length + 1,
                projectsByStatus: statusCounts,
                recentProjects: clientProjects.map(p => ({
                    id: p.id,
                    title: p.title,
                    status: p.status,
                    budget: p.budgetMin && p.budgetMax ? 
                        `$${p.budgetMin.toLocaleString()} - $${p.budgetMax.toLocaleString()}` : 
                        'Not specified',
                    createdAt: p.createdAt,
                    rejectedReason: p.rejectedReason
                })),
                rejectedCount: clientProjects.filter(p => p.status === 'CANCELLED').length,
                approvedCount: clientProjects.filter(p => p.status !== 'CANCELLED').length
            },
            waitingTime: {
                days: waitingDays,
                display: waitingDays === 0 ? 'Today' : 
                        waitingDays === 1 ? '1 day ago' : 
                        `${waitingDays} days ago`,
                urgency: waitingDays >= 7 ? 'high' : 
                        waitingDays >= 3 ? 'medium' : 'low'
            },
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            reviewFlags: {
                longWait: waitingDays >= 7,
                newClient: statusCounts.ADMIN_VERIFICATION <= 1,
                frequentRejections: (statusCounts.CANCELLED || 0) >= 3,
                suspiciousBudget: project.budgetMax && project.budgetMax > 100000,
                incompleteProfile: !project.client.companyName || !project.client.industry
            }
        };

        res.status(200).json({
            success: true,
            data: detailedProject
        });

    } catch (error) {
        console.error('Get project review details error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Get Project Status History/Activity
adminRouter.get('/projects/:projectId/activity', authenticateAdmin, requirePermission(['MODERATOR', 'SUPPORT']), async (req, res) => {
    try {
        const { projectId } = req.params;

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: {
                id: true,
                title: true,
                status: true,
                createdAt: true,
                updatedAt: true,
                rejectedReason: true
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found'
            });
        }

        // For now, create activity timeline based on available data
        // In a real app, you'd have an audit log table
        const activities = [
            {
                id: 1,
                type: 'CREATED',
                description: 'Project created and submitted for admin verification',
                timestamp: project.createdAt,
                actor: 'System',
                details: {
                    status: 'ADMIN_VERIFICATION'
                }
            }
        ];

        if (project.status !== 'ADMIN_VERIFICATION') {
            activities.push({
                id: 2,
                type: project.status === 'OPEN' ? 'APPROVED' : 'REJECTED',
                description: project.status === 'OPEN' ? 
                    'Project approved by admin and made public' : 
                    `Project rejected by admin: ${project.rejectedReason}`,
                timestamp: project.updatedAt,
                actor: 'Admin',
                details: {
                    status: project.status,
                    rejectedReason: project.rejectedReason
                }
            });
        }

        res.status(200).json({
            success: true,
            data: {
                projectId: project.id,
                title: project.title,
                currentStatus: project.status,
                activities: activities.reverse() // Most recent first
            }
        });

    } catch (error) {
        console.error('Get project activity error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});