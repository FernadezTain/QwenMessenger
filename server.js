import express from "express";
import bcrypt from "bcrypt";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { authenticator } from "otplib";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static("."));

const PORT = process.env.PORT || 3000;
const APP_BASE_URL = process.env.APP_BASE_URL || "https://qwen-messenger.vercel.app";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || "change-me";
const INDEX_FILE = fileURLToPath(new URL("./index.html", import.meta.url));

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment.");
}

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

authenticator.options = { window: 1 };

function nowIso() {
  return new Date().toISOString();
}

function addMinutes(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function normalizeUsername(value) {
  const cleaned = String(value || "").trim().replace(/^@+/, "");
  return cleaned ? `@${cleaned}` : "";
}

function usernameComparable(value) {
  return normalizeUsername(value).toLowerCase();
}

function ensure(condition, message, code = 400) {
  if (!condition) {
    const error = new Error(message);
    error.statusCode = code;
    throw error;
  }
}

function makeTempToken() {
  return crypto.randomBytes(24).toString("hex");
}

function signAdminToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", ADMIN_TOKEN_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto
    .createHmac("sha256", ADMIN_TOKEN_SECRET)
    .update(body)
    .digest("base64url");
  if (sig !== expected) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

async function sb(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      ...sbHeaders,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || text || "Supabase request failed");
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

async function getUserByComparable(comparable) {
  const rows = await sb(
    `messenger_users?username_comparable=eq.${encodeURIComponent(comparable)}&select=*`
  );
  return rows?.[0] || null;
}

async function getUserById(userId) {
  const rows = await sb(`messenger_users?id=eq.${encodeURIComponent(userId)}&select=*`);
  return rows?.[0] || null;
}

async function requireChatAccess(chatId, userId) {
  const rows = await sb(
    `messenger_chats?id=eq.${encodeURIComponent(chatId)}&or=(user_a.eq.${encodeURIComponent(
      userId
    )},user_b.eq.${encodeURIComponent(userId)})&select=*`
  );
  return rows?.[0] || null;
}

async function buildChatView(chat, currentUserId) {
  const otherUserId = chat.user_a === currentUserId ? chat.user_b : chat.user_a;
  const otherUser = await getUserById(otherUserId);
  const messages = await sb(
    `messenger_messages?chat_id=eq.${encodeURIComponent(chat.id)}&select=*&order=created_at.asc`
  );
  const lastMessage = messages[messages.length - 1] || null;

  return {
    id: chat.id,
    username: otherUser?.username || "@unknown",
    title: otherUser?.display_name || otherUser?.username || "@unknown",
    subtitle: otherUser?.bio || "Личный диалог",
    last_message: lastMessage?.text || "",
    last_message_at: lastMessage?.created_at || chat.created_at,
  };
}

async function buildUserPayload(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.username.replace(/^@/, ""),
    bio: user.bio || "",
    created_at: user.created_at,
  };
}

async function deleteTempSession(token) {
  await sb(`auth_temp_sessions?token=eq.${encodeURIComponent(token)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  const payload = verifyAdminToken(token);
  if (!payload) {
    return res.status(401).json({ success: false, error: "Нет доступа" });
  }
  req.admin = payload;
  next();
}

app.post("/api/auth/check-username", async (req, res) => {
  try {
    const comparable = usernameComparable(req.body.username || req.body.comparable);
    ensure(comparable.length >= 2, "Некорректный @username");
    const user = await getUserByComparable(comparable);
    res.json({ success: true, exists: Boolean(user) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/api/auth/register/start", async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const comparable = usernameComparable(req.body.comparable || username);
    const password = String(req.body.password || "");

    ensure(username, "Введите @username");
    ensure(password.length >= 10, "Пароль слишком короткий");

    const existing = await getUserByComparable(comparable);
    ensure(!existing, `${username} уже зарегистрирован`, 409);

    const passwordHash = await bcrypt.hash(password, 10);
    const secret = authenticator.generateSecret();
    const tempToken = makeTempToken();
    const otpauth = authenticator.keyuri(username, "Qwen Messenger", secret);
    const qrCode = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
      otpauth
    )}`;

    await sb("auth_temp_sessions", {
      method: "POST",
      body: JSON.stringify({
        token: tempToken,
        flow: "register",
        username,
        username_comparable: comparable,
        password_hash: passwordHash,
        totp_secret: secret,
        expires_at: addMinutes(20),
      }),
    });

    res.json({
      success: true,
      tempToken,
      qrCode,
      manualCode: secret,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const comparable = usernameComparable(req.body.comparable || req.body.username);
    const password = String(req.body.password || "");

    ensure(comparable, "Введите @username");
    ensure(password, "Введите пароль");

    const user = await getUserByComparable(comparable);
    ensure(user, "Пользователь не найден", 404);

    const ok = await bcrypt.compare(password, user.password_hash);
    ensure(ok, "Неверный пароль", 401);

    const tempToken = makeTempToken();
    await sb("auth_temp_sessions", {
      method: "POST",
      body: JSON.stringify({
        token: tempToken,
        flow: "login",
        user_id: user.id,
        username: user.username,
        username_comparable: user.username_comparable,
        expires_at: addMinutes(10),
      }),
    });

    res.json({ success: true, tempToken });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/api/auth/verify-2fa", async (req, res) => {
  try {
    const tempToken = String(req.body.tempToken || "");
    const code = String(req.body.code || "").trim();
    ensure(tempToken, "Сессия авторизации истекла");
    ensure(/^\d{6}$/.test(code), "Нужен 6-значный код");

    const rows = await sb(
      `auth_temp_sessions?token=eq.${encodeURIComponent(tempToken)}&select=*`
    );
    const session = rows?.[0];
    ensure(session, "Сессия авторизации не найдена", 404);
    ensure(new Date(session.expires_at).getTime() > Date.now(), "Время сессии истекло", 401);

    let user;
    if (session.flow === "register") {
      const valid = authenticator.verify({ token: code, secret: session.totp_secret });
      ensure(valid, "Неверный код Google Authenticator", 401);

      const existing = await getUserByComparable(session.username_comparable);
      ensure(!existing, "Этот @username уже заняли", 409);

      const inserted = await sb("messenger_users", {
        method: "POST",
        body: JSON.stringify({
          username: session.username,
          username_comparable: session.username_comparable,
          password_hash: session.password_hash,
          totp_secret: session.totp_secret,
          display_name: session.username.replace(/^@/, ""),
          bio: "",
        }),
      });
      user = inserted?.[0];
    } else if (session.flow === "login") {
      user = await getUserById(session.user_id);
      ensure(user, "Пользователь не найден", 404);
      const valid = authenticator.verify({ token: code, secret: user.totp_secret });
      ensure(valid, "Неверный код Google Authenticator", 401);
    } else {
      throw new Error("Неизвестный тип сессии");
    }

    await deleteTempSession(tempToken);
    res.json({
      success: true,
      userId: user.id,
      user: await buildUserPayload(user),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/api/messenger/chats", async (req, res) => {
  try {
    const userId = String(req.query.userId || "");
    ensure(userId, "Нет userId");

    const chats = await sb(
      `messenger_chats?or=(user_a.eq.${encodeURIComponent(userId)},user_b.eq.${encodeURIComponent(
        userId
      )})&select=*&order=updated_at.desc`
    );

    const normalized = await Promise.all(chats.map((chat) => buildChatView(chat, userId)));
    res.json({ success: true, chats: normalized });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/api/messenger/messages", async (req, res) => {
  try {
    const chatId = String(req.query.chatId || "");
    const userId = String(req.query.userId || "");
    ensure(chatId && userId, "Недостаточно данных");

    const chat = await requireChatAccess(chatId, userId);
    ensure(chat, "Чат не найден", 404);

    const messages = await sb(
      `messenger_messages?chat_id=eq.${encodeURIComponent(chatId)}&select=*&order=created_at.asc`
    );
    res.json({ success: true, messages });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/api/messenger/search-users", async (req, res) => {
  try {
    const query = usernameComparable(req.query.query);
    const userId = String(req.query.userId || "");
    ensure(query, "Введите запрос");

    const rows = await sb(
      `messenger_users?username_comparable=ilike.${encodeURIComponent(
        `${query}%`
      )}&select=id,username,display_name,bio&limit=10`
    );

    res.json({
      success: true,
      users: (rows || []).filter((row) => row.id !== userId),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/api/messenger/open-chat", async (req, res) => {
  try {
    const userId = String(req.body.userId || "");
    const targetUserId = String(req.body.targetUserId || "");
    ensure(userId && targetUserId, "Недостаточно данных");
    ensure(userId !== targetUserId, "Нельзя открыть чат с самим собой");

    const sortedPair = [userId, targetUserId].sort();
    const pairKey = `${sortedPair[0]}:${sortedPair[1]}`;

    let rows = await sb(`messenger_chats?pair_key=eq.${encodeURIComponent(pairKey)}&select=*`);
    let chat = rows?.[0];

    if (!chat) {
      const inserted = await sb("messenger_chats", {
        method: "POST",
        body: JSON.stringify({
          user_a: sortedPair[0],
          user_b: sortedPair[1],
          pair_key: pairKey,
          updated_at: nowIso(),
        }),
      });
      chat = inserted?.[0];
    }

    res.json({
      success: true,
      chat: await buildChatView(chat, userId),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/api/messenger/send-message", async (req, res) => {
  try {
    const chatId = String(req.body.chatId || "");
    const userId = String(req.body.userId || "");
    const text = String(req.body.text || "").trim();

    ensure(chatId && userId && text, "Недостаточно данных");
    ensure(text.length <= 4000, "Сообщение слишком длинное");

    const chat = await requireChatAccess(chatId, userId);
    ensure(chat, "Чат не найден", 404);

    const inserted = await sb("messenger_messages", {
      method: "POST",
      body: JSON.stringify({
        chat_id: chatId,
        sender_id: userId,
        text,
      }),
    });
    const message = inserted?.[0];

    await sb(`messenger_chats?id=eq.${encodeURIComponent(chatId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ updated_at: message.created_at }),
    });

    res.json({ success: true, message });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.patch("/api/messenger/profile", async (req, res) => {
  try {
    const userId = String(req.body.userId || "");
    ensure(userId, "Нет userId");

    const displayName = String(req.body.displayName || "").trim().slice(0, 80);
    const bio = String(req.body.bio || "").trim().slice(0, 240);

    const rows = await sb(`messenger_users?id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        display_name: displayName,
        bio,
      }),
    });

    res.json({
      success: true,
      user: await buildUserPayload(rows?.[0]),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/api/feedback-items", async (req, res) => {
  try {
    const type = String(req.body.type || "");
    const title = String(req.body.title || "").trim().slice(0, 120);
    const content = String(req.body.content || "").trim().slice(0, 4000);
    const authorName = String(req.body.authorName || "").trim().slice(0, 80) || "Аноним";
    const authorUsername = req.body.authorUsername
      ? normalizeUsername(req.body.authorUsername)
      : null;
    const authorUserId = req.body.userId || null;

    ensure(["feedback", "ideas"].includes(type), "Неверный тип записи");
    ensure(content, "Текст не может быть пустым");

    const inserted = await sb("feedback_items", {
      method: "POST",
      body: JSON.stringify({
        type,
        title: title || null,
        content,
        author_name: authorName,
        author_username: authorUsername,
        author_user_id: authorUserId,
      }),
    });

    res.json({ success: true, item: inserted?.[0] || null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const password = String(req.body.password || "");
    ensure(password, "Введите пароль администратора");

    const rows = await sb("admin_access?select=*&order=created_at.desc&limit=1");
    const adminRow = rows?.[0];
    ensure(adminRow, "Админ-пароль не настроен", 404);

    const ok = await bcrypt.compare(password, adminRow.password_hash);
    ensure(ok, "Неверный пароль администратора", 401);

    const token = signAdminToken({
      role: "admin",
      exp: Date.now() + 12 * 60 * 60 * 1000,
    });

    res.json({ success: true, token });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/api/admin/items", adminAuth, async (req, res) => {
  try {
    const type = String(req.query.type || "feedback");
    ensure(["feedback", "ideas"].includes(type), "Неизвестный раздел");

    const items = await sb(
      `feedback_items?type=eq.${encodeURIComponent(
        type
      )}&select=*&order=created_at.desc&limit=100`
    );

    res.json({ success: true, items });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ success: true, status: "ok" });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  res.sendFile(INDEX_FILE);
});

app.listen(PORT, () => {
  console.log(`Qwen Messenger API running on ${PORT}. Base URL: ${APP_BASE_URL}`);
});
