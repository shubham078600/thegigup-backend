import cloudinary from '../cloudinary.config.js';

// Upload image to Cloudinary (handles Buffer and file paths)
export const uploadImage = async (file, folder = 'client-profiles') => {
    try {
        if (Buffer.isBuffer(file)) {
            // Handle Buffer uploads using upload_stream
            return new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        folder: folder,
                        resource_type: 'auto',
                        quality: 'auto',
                        fetch_format: 'auto'
                    },
                    (error, result) => {
                        if (error) {
                            console.error('Cloudinary upload error:', error);
                            return reject({
                                success: false,
                                error: error.message
                            });
                        }
                        resolve({
                            success: true,
                            url: result.secure_url,
                            public_id: result.public_id
                        });
                    }
                );
                stream.end(file); // Pass the Buffer to the stream
            });
        } else {
            // Handle file path uploads
            const uploadResult = await cloudinary.uploader.upload(file, {
                folder: folder,
                resource_type: 'auto',
                quality: 'auto',
                fetch_format: 'auto'
            });

            return {
                success: true,
                url: uploadResult.secure_url,
                public_id: uploadResult.public_id
            };
        }
    } catch (error) {
        console.error('Cloudinary upload error:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

// Delete image from Cloudinary
export const deleteImage = async (publicId) => {
    try {
        const result = await cloudinary.uploader.destroy(publicId);
        return {
            success: true,
            result
        };
    } catch (error) {
        console.error('Cloudinary delete error:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

// Generate optimized URL
export const getOptimizedUrl = (publicId, options = {}) => {
    const defaultOptions = {
        fetch_format: 'auto',
        quality: 'auto',
        ...options
    };

    return cloudinary.url(publicId, defaultOptions);
};

// Generate thumbnail URL
export const getThumbnailUrl = (publicId, width = 150, height = 150) => {
    return cloudinary.url(publicId, {
        crop: 'fill',
        gravity: 'auto',
        width,
        height,
        fetch_format: 'auto',
        quality: 'auto'
    });
};