module.exports = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key || !process.env.API_KEY || key !== process.env.API_KEY)
    return res.status(403).json({ error: 'API key invalide' });
  next();
};
