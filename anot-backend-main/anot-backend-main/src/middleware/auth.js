const jwt = require('jsonwebtoken')

// This middleware protects routes that require login
const protect = (req, res, next) => {
    try {
        // Get token from request header
        const authHeader = req.headers.authorization

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Not authorized. No token provided.' })
        }

        // Extract the token
        const token = authHeader.split(' ')[1]

        // Verify the token
        const decoded = jwt.verify(token, process.env.JWT_SECRET)

        // Attach user info to the request
        req.user = decoded

        next()
    } catch (err) {
        return res.status(401).json({ error: 'Not authorized. Invalid token.' })
    }
}

// Role-based access control
// Usage: restrict('admin') or restrict('admin', 'clinician')
const restrict = (...roles) => {
    return (req, res, next) => {
        if (!req.user?.role) {
            return res.status(401).json({ error: 'Not authorized.' })
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                error: `Access denied. This route is for: ${roles.join(', ')} only.`,
            })
        }
        next()
    }
}

module.exports = { protect, restrict }