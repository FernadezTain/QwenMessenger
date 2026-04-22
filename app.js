const API_BASE = `${window.location.origin}/api`;

const state = {
  mode: window.location.pathname.startsWith("/admin") ? "admin" : "app",
  screen: "welcome",
  username: "",
  password: "",
  tempToken: "",
  authFlow: "",
  currentUser: null,
  profileOpen: false,
  profileView: "self",
  chats: [],
  activeChatId: null,
  messages: {},
  contextMenu: null,
  searchResults: [],
  adminSession: false,
  adminToken: "",
  adminTab: "feedback",
  adminItems: [],
  activeAdminItem: null,
};

const app = document.getElementById("app");
let messengerPollTimer = null;
const SESSION_KEY = "Fernie_messenger_session";

const passwordLevels = [
  { min: 0, label: "Слишком слабый", score: 0 },
  { min: 1, label: "Лёгкий", score: 1 },
  { min: 2, label: "Хороший", score: 2 },
  { min: 3, label: "Сильный", score: 3 },
  { min: 4, label: "Отличный", score: 4 },
];

function normalizeUsername(value) {
  const cleaned = (value || "").trim().replace(/^@+/, "");
  return cleaned ? `@${cleaned}` : "";
}

function usernameComparable(value) {
  return normalizeUsername(value).toLowerCase();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getInitial(name) {
  return (name || "@Q").replace("@", "").charAt(0).toUpperCase();
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "сейчас";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "сейчас";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function setScreen(screen) {
  state.screen = screen;
  render();
}

function saveUserSession() {
  if (!state.currentUser) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify(state.currentUser));
}

function clearUserSession() {
  localStorage.removeItem(SESSION_KEY);
}

function restoreUserSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const user = JSON.parse(raw);
    if (!user?.id || !user?.username) return false;
    state.currentUser = user;
    return true;
  } catch (_error) {
    clearUserSession();
    return false;
  }
}

function isMobileLayout() {
  return window.innerWidth <= 920;
}

function sortChatsByActivity(chats) {
  return [...chats].sort((a, b) => {
    const aTime = new Date(a.last_message_at || 0).getTime();
    const bTime = new Date(b.last_message_at || 0).getTime();
    return bTime - aTime;
  });
}

function areMessageListsEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].text !== b[i].text ||
      a[i].created_at !== b[i].created_at ||
      a[i].sender_id !== b[i].sender_id
    ) {
      return false;
    }
  }
  return true;
}

function areChatListsEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].title !== b[i].title ||
      a[i].last_message !== b[i].last_message ||
      a[i].last_message_at !== b[i].last_message_at
    ) {
      return false;
    }
  }
  return true;
}

function stopMessengerPolling() {
  if (messengerPollTimer) {
    clearInterval(messengerPollTimer);
    messengerPollTimer = null;
  }
}

function startMessengerPolling() {
  stopMessengerPolling();
  if (!state.currentUser) return;
  messengerPollTimer = setInterval(async () => {
    await syncMessengerData();
  }, 2500);
}

async function syncMessengerData() {
  if (!state.currentUser) return;
  try {
    const chatsData = await api(`/messenger/chats?userId=${encodeURIComponent(state.currentUser.id)}`);
    const nextChats = sortChatsByActivity(chatsData.chats || []);
    let shouldRender = !areChatListsEqual(state.chats, nextChats);
    state.chats = nextChats;

    if (state.activeChatId) {
      const messageData = await api(
        `/messenger/messages?chatId=${encodeURIComponent(state.activeChatId)}&userId=${encodeURIComponent(state.currentUser.id)}`
      );
      const nextMessages = messageData.messages || [];
      if (!areMessageListsEqual(state.messages[state.activeChatId] || [], nextMessages)) {
        state.messages[state.activeChatId] = nextMessages;
        shouldRender = true;
      }
    } else if (state.chats[0] && !isMobileLayout()) {
      state.activeChatId = state.chats[0].id;
      const firstMessages = await api(
        `/messenger/messages?chatId=${encodeURIComponent(state.activeChatId)}&userId=${encodeURIComponent(state.currentUser.id)}`
      );
      state.messages[state.activeChatId] = firstMessages.messages || [];
      shouldRender = true;
    }

    if (shouldRender) {
      renderMessenger();
    }
  } catch (_error) {
    // Ignore background polling errors.
  }
}

function setToast(text, type = "info") {
  const root = document.getElementById("toast-root");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = text;
  root.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3200);
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(path.startsWith("/admin") && state.adminToken
        ? { "x-admin-token": state.adminToken }
        : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || "Ошибка сервера");
  }
  return data;
}

function getPasswordStrength(password) {
  let score = 0;
  if (password.length >= 10) score += 1;
  if (/[A-ZА-Я]/.test(password)) score += 1;
  if (/[a-zа-я]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-zА-Яа-я0-9]/.test(password)) score += 1;
  return Math.min(score, 4);
}

function render() {
  app.classList.remove("app-messenger");

  if (state.mode === "admin") {
    renderAdminMode();
    return;
  }

  if (state.currentUser) {
    renderMessenger();
    return;
  }

  if (state.screen === "welcome") {
    renderWelcome();
    return;
  }

  if (state.screen === "username") {
    renderUsernameCheck();
    return;
  }

  if (state.screen === "register") {
    renderRegister();
    return;
  }

  if (state.screen === "login") {
    renderLogin();
    return;
  }

  if (state.screen === "totp-setup") {
    renderTotpSetup();
    return;
  }

  if (state.screen === "totp-verify") {
    renderTotpVerify();
  }
}

function renderWelcome() {
  app.innerHTML = `
    <div class="page-center">
      <section class="hero-card">
        <div class="eyebrow">Fernie Secure Chat</div>
        <h1 class="hero-title">Fernie, <span>Приветствуем!</span></h1>
        <p class="hero-text">
          Современный вход в мессенджер с системой <strong>@username</strong>, обязательной сильной защитой
          и подключением Google Authenticator перед первым входом.
        </p>
        <div class="hero-actions">
          <button id="start-btn" class="btn" type="button">Начать</button>
        </div>
      </section>
    </div>
  `;

  document.getElementById("start-btn").onclick = () => setScreen("username");
}
function renderUsernameCheck() {
  app.innerHTML = `
    <div class="page-center">
      <section class="auth-card">
        <div class="section-subtitle">Fernie | Аутентификация</div>
        <h2 class="section-title">Введите <span>@username</span></h2>
        <p class="section-text">
          Проверка происходит без учёта регистра. Например, <strong>@Banan123</strong> и <strong>@BaNaN123</strong>
          считаются одним и тем же username.
        </p>

        <div class="panel">
          <label class="label" for="username-input">Username</label>
          <input id="username-input" class="input" type="text" placeholder="@username">
          <div class="helper-row">
            <span>Username хранится как обычный текст</span>
            <span>без хэша</span>
          </div>
          <div id="username-message" class="message"></div>
          <div class="action-row" style="margin-top:18px;">
            <button id="back-from-username" class="btn secondary" type="button">Назад</button>
            <button id="check-username" class="btn" type="button">Далее</button>
          </div>
        </div>
      </section>
    </div>
  `;

  document.getElementById("back-from-username").onclick = () => setScreen("welcome");
  document.getElementById("check-username").onclick = onCheckUsername;
  document.getElementById("username-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") onCheckUsername();
  });
}

async function onCheckUsername() {
  const input = document.getElementById("username-input");
  const message = document.getElementById("username-message");
  const username = normalizeUsername(input.value);
  if (!username || username.length < 3) {
    message.className = "message error";
    message.textContent = "Введи корректный @username.";
    return;
  }

  state.username = username;
  message.className = "message info";
  message.textContent = "Проверяем username в Supabase...";

  try {
    const data = await api("/auth/check-username", {
      method: "POST",
      body: JSON.stringify({
        username,
        comparable: usernameComparable(username),
      }),
    });

    if (data.exists) {
      state.authFlow = "login";
      setScreen("login");
    } else {
      state.authFlow = "register";
      setScreen("register");
    }
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
  }
}

function renderRegister() {
  const score = getPasswordStrength(state.password);
  const strength = passwordLevels.find((item) => item.score === score) || passwordLevels[0];

  app.innerHTML = `
    <div class="page-center">
      <section class="auth-card">
        <div class="section-subtitle">Fernie | Регистрация</div>
        <h2 class="section-title"><span>${escapeHtml(state.username)}</span> свободен!</h2>
        <p class="section-text">Придумай пароль. Продолжить можно только когда сила пароля станет <strong>Отличный</strong>.</p>

        <div class="panel">
          <label class="label" for="register-password">Пароль</label>
          <input id="register-password" class="input" type="password" placeholder="Придумайте пароль">
          <div class="helper-row">
            <span>Текущий уровень</span>
            <strong>${strength.label}</strong>
          </div>
          <div class="strength">
            ${[1, 2, 3, 4].map((level) => `
              <div class="strength-bar ${score >= level ? "active" : ""}" data-level="${level}"></div>
            `).join("")}
          </div>
          <div class="helper-row">
            <span>Нужны длина, буквы, цифры и символы</span>
            <span>минимум 10+</span>
          </div>
          <div id="register-message" class="message"></div>
          <div class="action-row" style="margin-top:18px;">
            <button id="back-to-username" class="btn secondary" type="button">Назад</button>
            <button id="continue-register" class="btn" type="button">Продолжить</button>
          </div>
        </div>
      </section>
    </div>
  `;

  const passwordInput = document.getElementById("register-password");
  passwordInput.value = state.password;
  passwordInput.focus();
  passwordInput.addEventListener("input", (event) => {
    state.password = event.target.value;
    renderRegister();
  });
  passwordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") onStartRegistration();
  });

  document.getElementById("back-to-username").onclick = () => setScreen("username");
  document.getElementById("continue-register").onclick = onStartRegistration;
}

async function onStartRegistration() {
  const message = document.getElementById("register-message");
  const score = getPasswordStrength(state.password);
  if (score < 4) {
    message.className = "message error";
    message.textContent = "Пароль пока не дотягивает до уровня Отличный.";
    return;
  }

  message.className = "message info";
  message.textContent = "Создаём этап регистрации и 2FA...";

  try {
    const data = await api("/auth/register/start", {
      method: "POST",
      body: JSON.stringify({
        username: state.username,
        comparable: usernameComparable(state.username),
        password: state.password,
      }),
    });

    state.tempToken = data.tempToken || "";
    state.qrCode = data.qrCode || "";
    state.manualCode = data.manualCode || "";
    setScreen("totp-setup");
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
  }
}

function renderLogin() {
  app.innerHTML = `
    <div class="page-center">
      <section class="auth-card">
        <div class="section-subtitle">Fernie | Вход в аккаунт</div>
        <h2 class="section-title"><span>${escapeHtml(state.username)}</span> уже зарегистрирован!</h2>
        <p class="section-text">Введите пароль для входа. Проверка идёт на твоём сервере.</p>

        <div class="panel">
          <label class="label" for="login-password">Пароль</label>
          <input id="login-password" class="input" type="password" placeholder="Введите пароль">
          <div id="login-message" class="message"></div>
          <div class="action-row" style="margin-top:18px;">
            <button id="back-login" class="btn secondary" type="button">Назад</button>
            <button id="continue-login" class="btn" type="button">Продолжить</button>
          </div>
        </div>
      </section>
    </div>
  `;

  document.getElementById("back-login").onclick = () => setScreen("username");
  document.getElementById("continue-login").onclick = onLogin;
  document.getElementById("login-password").addEventListener("keydown", (event) => {
    if (event.key === "Enter") onLogin();
  });
}

async function onLogin() {
  const password = document.getElementById("login-password").value;
  const message = document.getElementById("login-message");
  if (!password) {
    message.className = "message error";
    message.textContent = "Введите пароль.";
    return;
  }

  message.className = "message info";
  message.textContent = "Проверяем пароль...";

  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: state.username,
        comparable: usernameComparable(state.username),
        password,
      }),
    });

    state.tempToken = data.tempToken || "";
    setScreen("totp-verify");
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
  }
}

function renderTotpSetup() {
  app.innerHTML = `
    <div class="page-center">
      <section class="auth-card">
        <div class="section-subtitle">Fernie | Google Authentificator</div>
        <h2 class="section-title">Подключи <span>2FA</span></h2>
        <p class="section-text">Отсканируй QR в Google Authenticator или введи код вручную.</p>

        <div class="panel">
          <div class="qr-box">
            <img class="qr-image" src="${escapeHtml(state.qrCode || "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=Fernie%20Authenticator")}" alt="QR code">
            <div>
              <div class="mini-card">
                <div class="label">Ручной код</div>
                <div class="secret-box">${escapeHtml(state.manualCode || "SERVER_WILL_RETURN_SECRET")}</div>
              </div>
              <div class="mini-card" style="margin-top:12px;">
                <div class="label">Важно</div>
                <div class="hint">После подключения нажми продолжить и введи 6-значный код из приложения.</div>
              </div>
            </div>
          </div>

          <div id="totp-setup-message" class="message"></div>
          <div class="action-row" style="margin-top:18px;">
            <button id="setup-back" class="btn secondary" type="button">Назад</button>
            <button id="setup-next" class="btn" type="button">Продолжить</button>
          </div>
        </div>
      </section>
    </div>
  `;

  document.getElementById("setup-back").onclick = () => setScreen("register");
  document.getElementById("setup-next").onclick = () => setScreen("totp-verify");
}

function renderTotpVerify() {
  app.innerHTML = `
    <div class="page-center">
      <section class="auth-card">
        <div class="section-subtitle">Fernie | Google Authentificator код</div>
        <h2 class="section-title">Введите <span>6-значный код</span></h2>
        <p class="section-text">Если код верный, ты попадёшь в аккаунт и откроется главная страница мессенджера.</p>

        <div class="panel">
          <label class="label" for="totp-code">Код</label>
          <input id="totp-code" class="code-input" inputmode="numeric" maxlength="6" placeholder="123456">
          <div id="totp-message" class="message"></div>
          <div class="action-row" style="margin-top:18px;">
            <button id="verify-back" class="btn secondary" type="button">Назад</button>
            <button id="verify-next" class="btn" type="button">Продолжить</button>
          </div>
        </div>
      </section>
    </div>
  `;

  document.getElementById("verify-back").onclick = () => {
    setScreen(state.authFlow === "register" ? "totp-setup" : "login");
  };
  document.getElementById("verify-next").onclick = onVerifyTotp;
  document.getElementById("totp-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") onVerifyTotp();
  });
}

async function onVerifyTotp() {
  const code = document.getElementById("totp-code").value.trim();
  const message = document.getElementById("totp-message");
  if (!/^\d{6}$/.test(code)) {
    message.className = "message error";
    message.textContent = "Нужен ровно 6-значный код.";
    return;
  }

  message.className = "message info";
  message.textContent = "Проверяем код...";

  try {
    const data = await api("/auth/verify-2fa", {
      method: "POST",
      body: JSON.stringify({
        tempToken: state.tempToken,
        code,
      }),
    });

    state.currentUser = data.user || {
      id: data.userId,
      username: state.username,
      display_name: state.username.replace("@", ""),
      bio: "Новый пользователь Fernie Messenger",
    };

    saveUserSession();
    await loadChats();
    startMessengerPolling();
    setToast("Вход выполнен", "success");
    render();
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
  }
}

async function loadChats() {
  try {
    const data = await api(`/messenger/chats?userId=${encodeURIComponent(state.currentUser.id)}`);
    state.chats = sortChatsByActivity(data.chats || []);
    if (!state.activeChatId && state.chats[0] && !isMobileLayout()) {
      state.activeChatId = state.chats[0].id;
      await openChat(state.activeChatId);
    }
  } catch (error) {
    state.chats = [];
    setToast(error.message, "error");
  }
}

async function openChat(chatId) {
  state.activeChatId = chatId;
  state.profileOpen = false;
  state.profileView = "self";
  state.contextMenu = null;
  if (!state.messages[chatId]) {
    try {
      const data = await api(`/messenger/messages?chatId=${encodeURIComponent(chatId)}&userId=${encodeURIComponent(state.currentUser.id)}`);
      state.messages[chatId] = data.messages || [];
    } catch (error) {
      state.messages[chatId] = [];
      setToast(error.message, "error");
    }
  }
  renderMessenger();
}

function openOwnProfile() {
  state.profileView = "self";
  state.profileOpen = true;
  state.contextMenu = null;
  renderMessenger();
}

function openChatProfile() {
  if (!state.activeChatId) return;
  state.profileView = "chat";
  state.profileOpen = true;
  state.contextMenu = null;
  renderMessenger();
}

function closeContextMenu() {
  if (!state.contextMenu) return;
  state.contextMenu = null;
  renderMessenger();
}

async function deleteMessageForEveryone(messageId) {
  if (!state.activeChatId || !messageId) return;
  try {
    await api("/messenger/message", {
      method: "DELETE",
      body: JSON.stringify({
        chatId: state.activeChatId,
        messageId,
        userId: state.currentUser.id,
      }),
    });

    state.messages[state.activeChatId] = (state.messages[state.activeChatId] || []).filter(
      (message) => String(message.id) !== String(messageId)
    );
    state.contextMenu = null;
    await syncMessengerData();
    renderMessenger();
    setToast("Сообщение удалено у всех", "success");
  } catch (error) {
    setToast(error.message, "error");
  }
}

async function deleteActiveChat() {
  if (!state.activeChatId) return;
  if (!window.confirm("Удалить чат полностью? Сообщения исчезнут у всех.")) return;

  const chatId = state.activeChatId;
  try {
    await api("/messenger/chat", {
      method: "DELETE",
      body: JSON.stringify({
        chatId,
        userId: state.currentUser.id,
      }),
    });

    state.chats = state.chats.filter((chat) => chat.id !== chatId);
    delete state.messages[chatId];
    state.activeChatId = null;
    state.profileOpen = false;
    state.profileView = "self";
    state.contextMenu = null;
    renderMessenger();
    setToast("Чат удалён", "success");
  } catch (error) {
    setToast(error.message, "error");
  }
}

renderMessenger = function renderMessenger() {
  app.classList.add("app-messenger");
  app.innerHTML = document.getElementById("shell-template").innerHTML;
  const shell = document.querySelector(".shell");
  const onMobile = isMobileLayout();

  if (shell) {
    if (onMobile) {
      if (state.profileOpen) {
        shell.classList.add("mobile-profile-mode");
      } else if (state.activeChatId) {
        shell.classList.add("mobile-chat-mode");
      } else {
        shell.classList.add("mobile-list-mode");
      }
    } else {
      shell.classList.add("desktop-mode");
    }
  }

  const chatList = document.getElementById("chat-list");
  if (!state.chats.length) {
    chatList.innerHTML = `
      <div class="empty-card">
        <div class="label">Пока нет чатов</div>
        <div class="muted">Ищи людей по @username сверху и открывай переписку.</div>
      </div>
      </div>
      </div>
    `;
  } else {
    chatList.innerHTML = state.chats.map((chat) => `
      <div class="chat-item ${state.activeChatId === chat.id ? "active" : ""}" data-chat-id="${chat.id}">
        <div class="user-line">
          <div class="username">${escapeHtml(chat.title || chat.username || "@user")}</div>
          <div class="meta">${formatTime(chat.last_message_at)}</div>
        </div>
        <div class="meta">${escapeHtml(chat.last_message || "Открой чат")}</div>
      </div>
    `).join("");
  }

  chatList.querySelectorAll(".chat-item").forEach((item) => {
    item.onclick = () => openChat(item.dataset.chatId);
  });

  const activeChat = state.chats.find((chat) => chat.id === state.activeChatId);
  const messages = state.messages[state.activeChatId] || [];
  const chatView = document.getElementById("chat-view");

  if (!activeChat) {
    chatView.innerHTML = `
      <div class="chat-screen chat-screen-empty">
        <div class="chat-empty">
        <div class="chat-empty-card">
          <div class="eyebrow">Fernie Messenger</div>
          <h2 class="section-title">Выбери <span>чат</span></h2>
          <p class="section-text">
            Найди пользователя по @username, открой диалог и обменивайся текстовыми сообщениями как в Telegram.
          </p>
        </div>
        </div>
      </div>
    `;
  } else {
    chatView.innerHTML = `
      <div class="chat-screen">
        <div class="chat-head">
        <div class="chat-head-main">
          ${onMobile ? `<button id="mobile-back-to-list" class="ghost-btn mobile-back-btn" type="button">← Чаты</button>` : ""}
          <h2 class="chat-title">${escapeHtml(activeChat.title || activeChat.username)}</h2>
          <div class="chat-sub">${escapeHtml(activeChat.subtitle || "Личный диалог")}</div>
        </div>
        <div class="chat-head-actions">
          <span class="badge">${escapeHtml(activeChat.username || state.username)}</span>
          ${onMobile ? `<button id="mobile-open-profile" class="ghost-btn" type="button">Профиль</button>` : ""}
        </div>
        </div>

        <div id="messages-box" class="chat-messages">
        ${messages.length ? messages.map((message) => `
          <div class="message-row ${message.sender_id === state.currentUser.id ? "own" : ""}">
            <div class="message-bubble">
              <div class="message-text">${escapeHtml(message.text)}</div>
              <div class="message-time">${formatTime(message.created_at)}</div>
            </div>
          </div>
        `).join("") : `
          <div class="empty-card">
            <div class="label">Пустой чат</div>
            <div class="muted">Напиши первое сообщение.</div>
          </div>
        `}
      </div>

      <div class="composer">
        <textarea id="message-input" class="textarea" placeholder="Напиши сообщение..." rows="2"></textarea>
        <button id="send-message" class="btn" type="button">Отправить</button>
      </div>
      </div>
    `;

    document.getElementById("send-message").onclick = onSendMessage;
    if (onMobile) {
      document.getElementById("mobile-back-to-list").onclick = () => {
        state.activeChatId = null;
        state.profileOpen = false;
        renderMessenger();
      };
      document.getElementById("mobile-open-profile").onclick = () => {
        state.profileOpen = true;
        renderMessenger();
      };
    }
  }

  renderProfilePanel();
  bindShellEvents();

  const messagesBox = document.getElementById("messages-box");
  if (messagesBox) {
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }
}

function renderProfilePanel() {
  const panel = document.getElementById("profile-panel");
  panel.classList.toggle("hidden", !state.profileOpen && isMobileLayout());
  const user = state.currentUser;
  panel.innerHTML = `
    <div class="profile-head">
      <strong>Профиль</strong>
      <div class="profile-head-actions">
        ${isMobileLayout() ? `<button id="close-profile-btn" class="ghost-btn" type="button">← Назад</button>` : ""}
        <button id="logout-btn" class="ghost-btn" type="button">Выйти</button>
      </div>
    </div>

    <div class="profile-stack">
      <div class="profile-card">
        <div class="avatar">${escapeHtml(getInitial(user.display_name || user.username))}</div>
        <h3>${escapeHtml(user.display_name || user.username)}</h3>
        <div class="meta">${escapeHtml(user.username)}</div>
        <p class="muted">${escapeHtml(user.bio || "Без описания")}</p>
      </div>

      <div class="profile-card">
        <label class="label" for="profile-display">Ник</label>
        <input id="profile-display" class="input" type="text" value="${escapeHtml(user.display_name || "")}">
        <label class="label" for="profile-bio" style="margin-top:12px;">О себе</label>
        <textarea id="profile-bio" class="textarea">${escapeHtml(user.bio || "")}</textarea>
        <div class="profile-actions" style="margin-top:12px;">
          <button id="save-profile" class="btn" type="button">Сохранить</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("logout-btn").onclick = () => {
    stopMessengerPolling();
    clearUserSession();
    state.currentUser = null;
    state.profileOpen = false;
    state.chats = [];
    state.messages = {};
    state.activeChatId = null;
    state.password = "";
    state.tempToken = "";
    state.username = "";
    setScreen("welcome");
  };
  if (isMobileLayout()) {
    document.getElementById("close-profile-btn").onclick = () => {
      state.profileOpen = false;
      renderMessenger();
    };
  }
  document.getElementById("save-profile").onclick = onSaveProfile;
}

function bindShellEvents() {
  document.getElementById("open-profile").onclick = () => {
    state.profileOpen = !state.profileOpen;
    renderMessenger();
  };

  const searchInput = document.getElementById("chat-search");
  searchInput.addEventListener("input", onSearchUsers);
}

async function onSearchUsers(event) {
  const query = normalizeUsername(event.target.value);
  const box = document.getElementById("chat-search-results");
  if (!query || query.length < 2) {
    state.searchResults = [];
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  try {
    const data = await api(`/messenger/search-users?query=${encodeURIComponent(query)}&userId=${encodeURIComponent(state.currentUser.id)}`);
    state.searchResults = data.users || [];
    box.classList.remove("hidden");
    box.innerHTML = state.searchResults.length
      ? state.searchResults.map((user) => `
        <div class="result-user" data-user-id="${user.id}">
          <div class="user-line">
            <span class="username">${escapeHtml(user.username)}</span>
            <span class="meta">${escapeHtml(user.display_name || "пользователь")}</span>
          </div>
          <div class="meta">${escapeHtml(user.bio || "Нажми, чтобы открыть чат")}</div>
        </div>
      `).join("")
      : `<div class="empty-card"><div class="muted">Ничего не найдено.</div></div>`;

    box.querySelectorAll(".result-user").forEach((item) => {
      item.onclick = async () => {
        try {
          const result = await api("/messenger/open-chat", {
            method: "POST",
            body: JSON.stringify({
              userId: state.currentUser.id,
              targetUserId: item.dataset.userId,
            }),
          });
          if (!state.chats.find((chat) => chat.id === result.chat.id)) {
            state.chats.unshift(result.chat);
          }
          state.activeChatId = result.chat.id;
          box.classList.add("hidden");
          box.innerHTML = "";
          document.getElementById("chat-search").value = "";
          await openChat(result.chat.id);
        } catch (error) {
          setToast(error.message, "error");
        }
      };
    });
  } catch (error) {
    box.classList.remove("hidden");
    box.innerHTML = `<div class="empty-card"><div class="muted">${escapeHtml(error.message)}</div></div>`;
  }
}

async function onSendMessage() {
  const input = document.getElementById("message-input");
  const text = input.value.trim();
  if (!text || !state.activeChatId) return;

  try {
    const data = await api("/messenger/send-message", {
      method: "POST",
      body: JSON.stringify({
        chatId: state.activeChatId,
        userId: state.currentUser.id,
        text,
      }),
    });

    state.messages[state.activeChatId] = [
      ...(state.messages[state.activeChatId] || []),
      data.message,
    ];

    state.chats = state.chats.map((chat) =>
      chat.id === state.activeChatId
        ? { ...chat, last_message: text, last_message_at: data.message.created_at }
        : chat
    );

    input.value = "";
    renderMessenger();
  } catch (error) {
    setToast(error.message, "error");
  }
}

async function onSaveProfile() {
  const displayName = document.getElementById("profile-display").value.trim();
  const bio = document.getElementById("profile-bio").value.trim();

  try {
    const data = await api("/messenger/profile", {
      method: "PATCH",
      body: JSON.stringify({
        userId: state.currentUser.id,
        displayName,
        bio,
      }),
    });

    state.currentUser = { ...state.currentUser, ...(data.user || { display_name: displayName, bio }) };
    saveUserSession();
    setToast("Профиль сохранён", "success");
    renderMessenger();
  } catch (error) {
    setToast(error.message, "error");
  }
}

function renderMessenger() {
  app.classList.add("app-messenger");
  app.innerHTML = document.getElementById("shell-template").innerHTML;
  const shell = document.querySelector(".shell");
  const onMobile = isMobileLayout();

  if (shell) {
    if (onMobile) {
      if (state.profileOpen) {
        shell.classList.add("mobile-profile-mode");
      } else if (state.activeChatId) {
        shell.classList.add("mobile-chat-mode");
      } else {
        shell.classList.add("mobile-list-mode");
      }
    } else {
      shell.classList.add("desktop-mode");
    }
  }

  const chatList = document.getElementById("chat-list");
  chatList.innerHTML = state.chats.length
    ? state.chats.map((chat) => `
      <div class="chat-item ${state.activeChatId === chat.id ? "active" : ""}" data-chat-id="${chat.id}">
        <div class="user-line">
          <div class="username">${escapeHtml(chat.title || chat.username || "@user")}</div>
          <div class="meta">${formatTime(chat.last_message_at)}</div>
        </div>
        <div class="meta">${escapeHtml(chat.last_message || "Открой чат")}</div>
      </div>
    `).join("")
    : `
      <div class="empty-card">
        <div class="label">Пока нет чатов</div>
        <div class="muted">Ищи людей по @username сверху и открывай переписку.</div>
      </div>
    `;

  chatList.querySelectorAll(".chat-item").forEach((item) => {
    item.onclick = () => openChat(item.dataset.chatId);
  });

  const activeChat = state.chats.find((chat) => chat.id === state.activeChatId);
  const messages = state.messages[state.activeChatId] || [];
  const chatView = document.getElementById("chat-view");

  if (!activeChat) {
    chatView.innerHTML = `
      <div class="chat-screen chat-screen-empty">
        <div class="chat-empty">
          <div class="chat-empty-card">
            <div class="eyebrow">Fernie Messenger</div>
            <h2 class="section-title">Выбери <span>чат</span></h2>
            <p class="section-text">Найди пользователя по @username и открой диалог.</p>
          </div>
        </div>
      </div>
    `;
  } else {
    chatView.innerHTML = `
      <div class="chat-screen">
        <button id="open-chat-profile" class="chat-head chat-profile-trigger" type="button">
          <div class="chat-head-main">
            ${onMobile ? `<span id="mobile-back-to-list" class="ghost-btn mobile-back-btn">← Чаты</span>` : ""}
            <h2 class="chat-title">${escapeHtml(activeChat.title || activeChat.username)}</h2>
            <div class="chat-sub">${escapeHtml(activeChat.subtitle || "Личный диалог")}</div>
          </div>
          <div class="chat-head-actions">
            <span class="badge">${escapeHtml(activeChat.username || state.username)}</span>
            <span class="chat-head-open">Открыть профиль</span>
          </div>
        </button>

        <div id="messages-box" class="chat-messages">
          ${messages.length ? messages.map((message) => `
            <div class="message-row ${message.sender_id === state.currentUser.id ? "own" : ""}">
              <div class="message-bubble ${message.sender_id === state.currentUser.id ? "can-open-menu" : ""}" data-message-id="${message.id}" data-own="${message.sender_id === state.currentUser.id ? "1" : "0"}">
                <div class="message-text">${escapeHtml(message.text)}</div>
                <div class="message-time">${formatTime(message.created_at)}</div>
              </div>
            </div>
          `).join("") : `
            <div class="empty-card">
              <div class="label">Пустой чат</div>
              <div class="muted">Напиши первое сообщение.</div>
            </div>
          `}
        </div>

        <div class="composer">
          <textarea id="message-input" class="textarea" placeholder="Напиши сообщение..." rows="2"></textarea>
          <button id="send-message" class="btn" type="button">Отправить</button>
        </div>
      </div>
    `;
  }

  renderProfilePanel(activeChat);
  renderContextMenu();
  bindShellEvents(activeChat);

  const messagesBox = document.getElementById("messages-box");
  if (messagesBox) {
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }
};

renderProfilePanel = function renderProfilePanel(activeChat) {
  const panel = document.getElementById("profile-panel");
  panel.classList.toggle("hidden", !state.profileOpen && isMobileLayout());

  if (!state.profileOpen && isMobileLayout()) {
    panel.innerHTML = "";
    return;
  }

  if (state.profileView === "chat" && activeChat) {
    panel.innerHTML = `
      <div class="contact-profile">
        <div class="contact-hero">
          <div class="contact-hero-top">
            <button id="back-from-contact" class="ghost-btn" type="button">${isMobileLayout() ? "← Назад" : "Вернуться в чат"}</button>
            <button id="delete-chat-btn" class="ghost-btn danger-ghost" type="button">Удалить чат</button>
          </div>
          <div class="contact-avatar contact-avatar-lg">${escapeHtml(getInitial(activeChat.title || activeChat.username))}</div>
          <h2 class="contact-name">${escapeHtml(activeChat.title || activeChat.username)}</h2>
          <div class="contact-username">${escapeHtml(activeChat.username || "@user")}</div>
          <p class="contact-bio">${escapeHtml(activeChat.subtitle || "Личный диалог")}</p>
        </div>

        <div class="contact-actions">
          <button id="back-to-chat-btn" class="contact-action primary-action" type="button">Вернуться в чат</button>
          <button id="delete-chat-card-btn" class="contact-action danger-action" type="button">Удалить чат</button>
        </div>

        <div class="contact-card-grid">
          <div class="contact-info-card">
            <div class="label">Имя пользователя</div>
            <div class="contact-card-value">${escapeHtml(activeChat.username || "@user")}</div>
          </div>
          <div class="contact-info-card">
            <div class="label">Диалог</div>
            <div class="contact-card-value">Личный чат</div>
          </div>
          <div class="contact-info-card full">
            <div class="label">О пользователе</div>
            <div class="muted">${escapeHtml(activeChat.subtitle || "Без описания")}</div>
          </div>
        </div>
      </div>
    `;

    const closeContact = () => {
      state.profileOpen = false;
      state.profileView = "self";
      renderMessenger();
    };

    document.getElementById("back-from-contact").onclick = closeContact;
    document.getElementById("back-to-chat-btn").onclick = closeContact;
    document.getElementById("delete-chat-btn").onclick = deleteActiveChat;
    document.getElementById("delete-chat-card-btn").onclick = deleteActiveChat;
    return;
  }

  const user = state.currentUser;
  panel.innerHTML = `
    <div class="profile-head">
      <strong>Профиль</strong>
      <div class="profile-head-actions">
        ${isMobileLayout() ? `<button id="close-profile-btn" class="ghost-btn" type="button">← Назад</button>` : ""}
        <button id="logout-btn" class="ghost-btn" type="button">Выйти</button>
      </div>
    </div>

    <div class="profile-stack">
      <div class="profile-card">
        <div class="avatar">${escapeHtml(getInitial(user.display_name || user.username))}</div>
        <h3>${escapeHtml(user.display_name || user.username)}</h3>
        <div class="meta">${escapeHtml(user.username)}</div>
        <p class="muted">${escapeHtml(user.bio || "Без описания")}</p>
      </div>

      <div class="profile-card">
        <label class="label" for="profile-display">Ник</label>
        <input id="profile-display" class="input" type="text" value="${escapeHtml(user.display_name || "")}">
        <label class="label" for="profile-bio" style="margin-top:12px;">О себе</label>
        <textarea id="profile-bio" class="textarea">${escapeHtml(user.bio || "")}</textarea>
        <div class="profile-actions" style="margin-top:12px;">
          <button id="save-profile" class="btn" type="button">Сохранить</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("logout-btn").onclick = () => {
    stopMessengerPolling();
    clearUserSession();
    state.currentUser = null;
    state.profileOpen = false;
    state.profileView = "self";
    state.contextMenu = null;
    state.chats = [];
    state.messages = {};
    state.activeChatId = null;
    state.password = "";
    state.tempToken = "";
    state.username = "";
    setScreen("welcome");
  };

  if (isMobileLayout()) {
    document.getElementById("close-profile-btn").onclick = () => {
      state.profileOpen = false;
      state.profileView = "self";
      renderMessenger();
    };
  }

  document.getElementById("save-profile").onclick = onSaveProfile;
};

function renderContextMenu() {
  const root = document.getElementById("floating-root");
  if (!root) return;

  if (!state.contextMenu) {
    root.innerHTML = "";
    return;
  }

  root.innerHTML = `
    <div id="message-menu-backdrop" class="message-menu-backdrop"></div>
    <div class="message-menu" style="left:${state.contextMenu.x}px; top:${state.contextMenu.y}px;">
      <div class="message-menu-title">Действия</div>
      <button id="delete-message-for-all" class="message-menu-btn danger" type="button">Удалить у всех</button>
    </div>
  `;

  document.getElementById("message-menu-backdrop").onclick = closeContextMenu;
  document.getElementById("delete-message-for-all").onclick = () => deleteMessageForEveryone(state.contextMenu.messageId);
}

bindShellEvents = function bindShellEvents(activeChat) {
  document.getElementById("open-profile").onclick = () => {
    if (state.profileOpen && state.profileView === "self") {
      state.profileOpen = false;
    } else {
      state.profileView = "self";
      state.profileOpen = true;
    }
    renderMessenger();
  };

  const searchInput = document.getElementById("chat-search");
  searchInput.addEventListener("input", onSearchUsers);

  const mobileChatsBtn = document.getElementById("mobile-nav-chats");
  const mobileSearchBtn = document.getElementById("mobile-nav-search");
  const mobileProfileBtn = document.getElementById("mobile-nav-profile");

  [mobileChatsBtn, mobileSearchBtn, mobileProfileBtn].forEach((button) => {
    if (button) button.classList.remove("active");
  });

  if (mobileProfileBtn && state.profileOpen) {
    mobileProfileBtn.classList.add("active");
  } else if (mobileChatsBtn) {
    mobileChatsBtn.classList.add("active");
  }

  if (mobileChatsBtn) {
    mobileChatsBtn.onclick = () => {
      state.profileOpen = false;
      state.profileView = "self";
      state.contextMenu = null;
      state.activeChatId = null;
      renderMessenger();
    };
  }

  if (mobileSearchBtn) {
    mobileSearchBtn.onclick = () => {
      state.profileOpen = false;
      state.profileView = "self";
      renderMessenger();
      setTimeout(() => document.getElementById("chat-search")?.focus(), 0);
    };
  }

  if (mobileProfileBtn) {
    mobileProfileBtn.onclick = openOwnProfile;
  }

  if (!activeChat) {
    return;
  }

  document.getElementById("send-message").onclick = onSendMessage;
  document.getElementById("open-chat-profile").onclick = openChatProfile;

  if (isMobileLayout() && document.getElementById("mobile-back-to-list")) {
    document.getElementById("mobile-back-to-list").onclick = (event) => {
      event.stopPropagation();
      state.activeChatId = null;
      state.profileOpen = false;
      state.profileView = "self";
      renderMessenger();
    };
  }

  document.querySelectorAll(".message-bubble[data-own='1']").forEach((bubble) => {
    bubble.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      state.contextMenu = {
        x: Math.min(event.clientX, window.innerWidth - 220),
        y: Math.min(event.clientY, window.innerHeight - 120),
        messageId: bubble.dataset.messageId,
      };
      renderMessenger();
    });
  });
};

function renderAdminMode() {
  if (!state.adminSession) {
    renderAdminLogin();
    return;
  }

  renderAdminDashboard();
}

function renderAdminLogin() {
  app.innerHTML = `
    <div class="page-center">
      <section class="admin-card">
        <div class="section-subtitle">Fernie | Admin</div>
        <h1 class="admin-title"><span>Админ-панель</span></h1>
        <p class="section-text">
          Введи пароль администратора. Он должен храниться на сервере в Supabase в хэшированном виде,
          отдельно от обычных аккаунтов.
        </p>

        <div class="panel">
          <label class="label" for="admin-password">Пароль администратора</label>
          <input id="admin-password" class="input" type="password" placeholder="Введите пароль">
          <div id="admin-login-message" class="message"></div>
          <div class="action-row" style="margin-top:18px;">
            <button id="admin-home" class="btn secondary" type="button">На главную</button>
            <button id="admin-enter" class="btn" type="button">Войти</button>
          </div>
        </div>
      </section>
    </div>
  `;

  document.getElementById("admin-home").onclick = () => {
    window.location.pathname = "/";
  };
  document.getElementById("admin-enter").onclick = onAdminLogin;
}

async function onAdminLogin() {
  const password = document.getElementById("admin-password").value;
  const message = document.getElementById("admin-login-message");
  if (!password) {
    message.className = "message error";
    message.textContent = "Введите пароль администратора.";
    return;
  }

  message.className = "message info";
  message.textContent = "Проверяем доступ...";

  try {
    const loginData = await api("/admin/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    state.adminToken = loginData.token || "";
    state.adminSession = true;
    await loadAdminItems();
    renderAdminDashboard();
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
  }
}

async function loadAdminItems() {
  try {
    const data = await api(`/admin/items?type=${encodeURIComponent(state.adminTab)}`);
    state.adminItems = data.items || [];
    state.activeAdminItem = state.adminItems[0] || null;
  } catch (error) {
    state.adminItems = [];
    state.activeAdminItem = null;
    setToast(error.message, "error");
  }
}

function renderAdminDashboard() {
  app.innerHTML = `
    <div class="page-center">
      <section class="admin-card" style="width:min(100%, 1040px);">
        <div class="admin-head">
          <div>
            <div class="section-subtitle">Fernie | Admin Dashboard</div>
            <h1 class="admin-title">Раздел <span>модерации</span></h1>
          </div>
          <button id="admin-logout" class="btn secondary" type="button">Выйти</button>
        </div>

        <div class="admin-tabs">
          <button class="tab-btn ${state.adminTab === "feedback" ? "active" : ""}" data-tab="feedback" type="button">Отзывы</button>
          <button class="tab-btn ${state.adminTab === "ideas" ? "active" : ""}" data-tab="ideas" type="button">Идеи</button>
        </div>

        <div class="admin-layout">
          <div class="admin-list">
            ${state.adminItems.length ? state.adminItems.map((item) => `
              <div class="admin-item" data-item-id="${item.id}">
                <div class="item-line">
                  <strong>${state.adminTab === "ideas" ? "Идея" : "Отзыв"} от ${escapeHtml(item.author_name || "аноним")}</strong>
                  <span class="meta">${formatDate(item.created_at)}</span>
                </div>
                <div class="meta italic">Нажмите чтобы посмотреть</div>
              </div>
            `).join("") : `
              <div class="empty-card">
                <div class="label">Пусто</div>
                <div class="muted">Новых записей пока нет.</div>
              </div>
            `}
          </div>

          <div class="admin-detail">
            ${state.activeAdminItem ? `
              <div class="panel">
                <div class="label">${state.adminTab === "ideas" ? "Идея" : "Отзыв"} от ${escapeHtml(state.activeAdminItem.author_name || "аноним")}</div>
                <h3>${escapeHtml(state.activeAdminItem.title || "Без заголовка")}</h3>
                <p class="section-text">${escapeHtml(state.activeAdminItem.content || "")}</p>
                <div class="badge">${escapeHtml(state.activeAdminItem.author_username || "аноним")}</div>
              </div>
            ` : `
              <div class="empty-card">
                <div class="muted">Выбери запись слева.</div>
              </div>
            `}
          </div>
        </div>
      </section>
    </div>
  `;

  document.getElementById("admin-logout").onclick = () => {
    state.adminSession = false;
    state.adminToken = "";
    state.adminItems = [];
    state.activeAdminItem = null;
    renderAdminLogin();
  };

  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.onclick = async () => {
      state.adminTab = button.dataset.tab;
      await loadAdminItems();
      renderAdminDashboard();
    };
  });

  document.querySelectorAll("[data-item-id]").forEach((item) => {
    item.onclick = () => {
      state.activeAdminItem = state.adminItems.find((entry) => String(entry.id) === item.dataset.itemId) || null;
      renderAdminDashboard();
    };
  });
}

if (restoreUserSession()) {
  loadChats()
    .then(() => {
      startMessengerPolling();
      render();
    })
    .catch(() => {
      stopMessengerPolling();
      clearUserSession();
      state.currentUser = null;
      render();
    });
} else {
  render();
}
