const express = require("express");

module.exports = function authController(sessions, config, utils) {
  const router = express.Router();
  const { GOOGLE_CLIENT_ID, APP_PASSWORD, APP_USER } = config;
  const { generarToken, verificarSesion } = utils;

  router.get("/config", (_req, res) => {
    res.json({
      googleClientId: GOOGLE_CLIENT_ID || null,
      hasPassword: !!APP_PASSWORD
    });
  });

  router.post("/google", async (req, res) => {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: "Sin credencial" });
    if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: "Google OAuth no configurado" });
    try {
      const gRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
      if (!gRes.ok) throw new Error("Token de Google inválido");
      const payload = await gRes.json();
      if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error("Client ID no coincide");
      const token = generarToken();
      sessions.set(token, {
        email: payload.email, name: payload.name, picture: payload.picture,
        provider: "google", createdAt: Date.now()
      });
      res.json({ token, user: { email: payload.email, name: payload.name, picture: payload.picture } });
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  });

  router.post("/login", (req, res) => {
    const { username, password } = req.body;
    if (!APP_PASSWORD) return res.status(400).json({ error: "Login con contraseña no configurado" });
    if (username === APP_USER && password === APP_PASSWORD) {
      const token = generarToken();
      sessions.set(token, {
        email: null, name: username, picture: null,
        provider: "password", createdAt: Date.now()
      });
      return res.json({ token, user: { name: username, picture: null } });
    }
    res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  });

  router.get("/me", (req, res) => {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const session = verificarSesion(token);
    if (!session) return res.status(401).json({ error: "No autenticado" });
    res.json({ user: { name: session.name, email: session.email, picture: session.picture } });
  });

  router.post("/logout", (req, res) => {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    sessions.delete(token);
    res.json({ ok: true });
  });

  return router;
};
