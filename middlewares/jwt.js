import jwt from 'jsonwebtoken';

export function sign(payload) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET no está definido o es demasiado corto (mínimo 32 caracteres).");
  }

  return jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

export function verify(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.sendStatus(401);

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error("Error de configuración: JWT_SECRET no es válido.");
    return res.status(500).json({ error: "Error interno de configuración de seguridad." });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.sendStatus(403);
  }
}
