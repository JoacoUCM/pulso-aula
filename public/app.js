import { qrSvg } from "./qr.js";
const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
let role =
    location.pathname === "/alumno"
      ? "student"
      : location.pathname === "/pantalla"
        ? "display"
        : "teacher",
  sessions = [],
  authState = { authenticated: false, email: null, legacySessions: false },
  current = null,
  selected = null,
  stage = null,
  busy = false,
  last = 0,
  serverOffset = 0,
  signature = "",
  joinCode = new URLSearchParams(location.search).get("codigo") || "",
  resetToken = new URLSearchParams(location.search).get("reset") || "",
  authView = resetToken ? "reset" : "default",
  resetRequested = false,
  timer,
  pollTimer;
const icons = {
  plus: "＋",
  play: "▶",
  close: "■",
  arrow: "→",
  check: "✓",
  clock: "◷",
  chart: "▥",
  download: "↓",
  upload: "↑",
  people: "♙",
};
const icon = (n) => `<span aria-hidden="true">${icons[n]}</span>`;
const button = (label, action, cls = "secondary", extra = "") =>
  `<button class="btn ${cls}" data-action="${action}" ${extra}>${label}</button>`;
const studentLink = (code) => `${location.origin}/alumno?codigo=${code}`;
function notify(text, error = false) {
  $("#notice").textContent = text;
  $("#notice").className = error ? "show error" : "show";
  clearTimeout(timer);
  timer = setTimeout(() => ($("#notice").className = ""), 6000);
}
async function api(url, body) {
  const started = Date.now();
  let r;
  try {
    r = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Error(
      "No se pudo contactar con el servidor. Comprueba tu conexión y vuelve a intentarlo.",
    );
  }
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error(
      "El servidor devolvió una respuesta no válida. Recarga la página e inténtalo de nuevo.",
    );
  }
  if (!r.ok) throw Error(data.error || "No se ha podido conectar.");
  if (data.serverNow)
    serverOffset = data.serverNow - (started + Date.now()) / 2;
  return data;
}
const passwordEncoder = new TextEncoder();
const passwordHex = (bytes) =>
  [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
const passwordSalt = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return passwordHex(bytes);
};
const saltBytes = (salt) =>
  new Uint8Array(salt.match(/.{2}/g).map((value) => Number.parseInt(value, 16)));
async function derivePassword(password, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    passwordEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return passwordHex(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: saltBytes(salt), iterations: 210000 },
      key,
      256,
    ),
  );
}
const endpoint = (a) => `/api/sessions/${current.code}/${a}`;
function applyBootstrap(data) {
  authState = {
    authenticated: Boolean(data.authenticated),
    email: data.email || null,
    legacySessions: Boolean(data.legacySessions),
  };
  sessions = data.sessions || [];
  if (!authState.authenticated) current = null;
}
function header() {
  if (role === "display")
    return `<header class="display-header"><span class="brand"><img src="/favicon.svg" alt="">pulso<span>AULA</span></span><span class="header-note">Pantalla de proyección · ${current?.teacher ? "Controles del profesor" : "Solo lectura"}</span></header>`;
  if (role === "student")
    return `<header><span class="brand"><img src="/favicon.svg" alt="">pulso<span>AULA</span></span><span class="header-note">Vista del alumno · Cada respuesta cuenta.</span></header>`;
  return `<header><a class="brand" href="/" aria-label="Pulso, inicio"><img src="/favicon.svg" alt="">pulso<span>AULA</span></a><nav aria-label="Vista"><button data-action="student">Entrar como alumno</button></nav>${authState.authenticated ? `<div class="teacher-account"><span>${esc(authState.email)}</span>${button("Cerrar sesión", "logout", "text")}</div>` : '<span class="header-note">Acceso del profesor</span>'}</header>`;
}
function authPage() {
  if (authView === "reset")
    return `<main class="auth-page"><div class="auth-heading"><span class="eyebrow">RECUPERACIÓN DE CONTRASEÑA</span><h1>Crea una contraseña nueva.</h1><p>El enlace solo puede utilizarse una vez y caduca 30 minutos después de solicitarlo.</p></div><div class="auth-grid single"><form id="reset-password-form" class="panel auth-card auth-card-center"><h2>Nueva contraseña</h2><label>Contraseña nueva<input name="password" type="password" minlength="10" maxlength="128" required autocomplete="new-password"></label><label>Repite la contraseña<input name="confirm" type="password" minlength="10" maxlength="128" required autocomplete="new-password"></label><p class="hint">Utiliza al menos 10 caracteres.</p><button class="btn primary full" type="submit">Guardar contraseña y entrar</button><button class="btn text full" type="button" data-action="auth-home">Volver al inicio</button></form></div></main>`;
  if (authView === "forgot")
    return `<main class="auth-page"><div class="auth-heading"><span class="eyebrow">RECUPERACIÓN DE CONTRASEÑA</span><h1>Recupera el acceso a tus encuestas.</h1><p>Escribe el correo con el que creaste tu cuenta.</p></div><div class="auth-grid single">${resetRequested ? `<section class="panel auth-card auth-card-center auth-message"><span class="tag green">SOLICITUD RECIBIDA</span><h2>Comprueba tu correo</h2><p>Si existe una cuenta con ese correo, recibirás un enlace válido durante 30 minutos. Revisa también la carpeta de correo no deseado.</p><button class="btn secondary full" type="button" data-action="auth-home">Volver a iniciar sesión</button></section>` : `<form id="password-request-form" class="panel auth-card auth-card-center"><h2>Enviar enlace</h2><label>Correo electrónico<input name="email" type="email" maxlength="254" required autocomplete="email" placeholder="nombre@universidad.es"></label><button class="btn primary full" type="submit">Enviar enlace de recuperación</button><button class="btn text full" type="button" data-action="auth-home">Volver a iniciar sesión</button></form>`}</div></main>`;
  return `<main class="auth-page"><div class="auth-heading"><span class="eyebrow">ACCESO DOCENTE</span><h1>Tus encuestas, desde cualquier ordenador.</h1><p>Inicia sesión con tu correo y contraseña. Si todavía no tienes cuenta, créala desde el navegador donde conservas tus encuestas actuales.</p>${authState.legacySessions ? '<div class="legacy-notice"><strong>Hemos encontrado encuestas en este navegador.</strong><span>Al crear tu cuenta se vincularán automáticamente y podrás abrirlas desde otros ordenadores.</span></div>' : ""}</div><div class="auth-grid"><form id="login-form" class="panel auth-card"><span class="tag purple">YA TENGO CUENTA</span><h2>Iniciar sesión</h2><label>Correo electrónico<input name="email" type="email" maxlength="254" required autocomplete="email" placeholder="nombre@universidad.es"></label><label>Contraseña<input name="password" type="password" minlength="10" maxlength="128" required autocomplete="current-password"></label><button class="btn primary full" type="submit">Entrar</button><button class="btn text full" type="button" data-action="forgot-password">He olvidado mi contraseña</button></form><form id="register-form" class="panel auth-card"><span class="tag green">PRIMER ACCESO</span><h2>Crear cuenta</h2><label>Correo electrónico<input name="email" type="email" maxlength="254" required autocomplete="email" placeholder="nombre@universidad.es"></label><label>Contraseña<input name="password" type="password" minlength="10" maxlength="128" required autocomplete="new-password"></label><label>Repite la contraseña<input name="confirm" type="password" minlength="10" maxlength="128" required autocomplete="new-password"></label><p class="hint">Utiliza al menos 10 caracteres. La contraseña se protege en este dispositivo antes de enviarse y nunca se guarda como texto.</p><button class="btn secondary full" type="submit">Crear cuenta y vincular mis encuestas</button></form></div></main>`;
}
function home() {
  return `<main class="home"><div class="eyebrow">TU ESPACIO DOCENTE</div><div class="title-row"><div><h1>Una clase. Todas las voces.</h1><p>Prepara tus preguntas y descubre qué ha entendido tu clase.</p></div>${button(icon("plus") + " Nueva sesión", "create", "primary")}</div><section class="welcome"><div><span class="tag light">DE LA PREGUNTA A LA CONVERSACIÓN</span><h2>Activa la curiosidad<br>de tu próxima clase.</h2><p>Crea una sesión, comparte el código y deja que respondan.<br>Los resultados aparecen cuando termina el tiempo.</p>${button("Crear una sesión " + icon("arrow"), "create", "white")}</div><div class="illustration" aria-hidden="true"><div class="mini-title">El aula tiene algo que decir.</div><div class="mini-bars"><i style="height:38%"></i><i style="height:66%"></i><i style="height:92%"></i><i style="height:48%"></i></div><div class="mini-labels"><span>A</span><span>B</span><span>C</span><span>D</span></div></div></section><div class="section-title"><h2>Mis sesiones</h2><span>${sessions.length} sesiones</span></div>${sessions.length ? `<div class="session-grid">${sessions.map((s) => `<article class="session-card"><button class="session-open" data-action="open" data-code="${s.code}"><div><span class="session-icon">${icon("chart")}</span><span class="tag ${s.ended ? "" : "purple"}">${s.ended ? "Finalizada" : "Preparada / en curso"}</span></div><h3>${esc(s.title)}</h3><p>Código ${s.code} <span>· ${new Date(s.created).toLocaleDateString("es-ES")}</span></p><div class="card-bottom">Abrir sesión ${icon("arrow")}</div></button><div class="session-card-actions"><button class="session-duplicate" data-action="duplicate" data-code="${s.code}" aria-label="Duplicar la sesión ${esc(s.title)}">Duplicar</button><button class="session-delete" data-action="ask-delete" data-code="${s.code}" aria-label="Eliminar la sesión ${esc(s.title)}">Eliminar</button></div></article>`).join("")}</div>` : `<section class="empty"><div class="empty-icon">${icon("chart")}</div><h3>Tu primera sesión empieza aquí</h3><p>Añade preguntas a mano o importa tu tabla de Excel.</p>${button("Crear sesión", "create", "primary")}</section>`}<p class="footnote">Tus encuestas están vinculadas a <strong>${esc(authState.email)}</strong> y aparecerán al iniciar sesión desde cualquier ordenador.</p></main>`;
}
function join() {
  return `<main class="join"><div class="join-heading"><span class="eyebrow">VAMOS A PARTICIPAR</span><h1>Tu voz está en clase.</h1><p>Introduce el código que comparte tu profesor.</p></div><form id="join-form" class="panel join-panel"><label>Código de sesión<input name="code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="000000" class="code-input" value="${esc(joinCode)}"></label><label>Tu nombre o identificador<input name="name" maxlength="60" required autocomplete="nickname" placeholder="Por ejemplo, Lucía M."></label><p class="hint">El profesor podrá ver tu nombre y tus respuestas.</p><button class="btn primary full" type="submit">Entrar en la sesión ${icon("arrow")}</button></form><p class="footnote">Una respuesta por pregunta. Los resultados se revelan al terminar.</p></main>`;
}
const status = (q) =>
  q.closed !== null
    ? "Cerrada"
    : q.started !== null
      ? "En directo"
      : "Pendiente";
function stats(q) {
  const r = q.result;
  if (!r) return "";
  return `<div class="results-heading"><span class="tag green">RESULTADOS</span><span>${r.total} respuesta${r.total !== 1 ? "s" : ""}</span></div><div class="bars">${q.options.map((o, i) => `<div class="bar-row"><div class="bar-label"><span><b>${String.fromCharCode(65 + i)}</b> ${esc(o)} ${i === q.correct ? '<span class="correct-marker">✓ Correcta</span>' : ""}</span><strong>${r.percentages[i].toFixed(1)}%</strong></div><div class="bar-track"><div class="bar-fill ${i === q.correct ? "correct" : ""}" style="width:${r.percentages[i]}%"></div></div><span class="bar-count">${r.counts[i]} respuesta${r.counts[i] !== 1 ? "s" : ""}</span></div>`).join("")}</div><div class="score-grid"><div><span class="score good">${r.correctPercent.toFixed(1)}%</span><span>Aciertos</span></div><div><span class="score bad">${r.errorPercent.toFixed(1)}%</span><span>Errores</span></div><div><span class="score">${Math.max(0, current.participants - r.total)}</span><span>Sin respuesta</span></div></div><p class="hint">Porcentajes sobre las respuestas recibidas. Las ausencias no cuentan como errores.</p>`;
}
function questionPanel(q) {
  if (!q)
    return `<div class="question-empty"><div class="empty-icon">?</div><h2>Prepara la primera pregunta</h2><p>Escríbela o importa las preguntas de tu Excel.</p><div class="actions">${button(icon("plus") + " Añadir pregunta", "add", "primary")}${button(icon("upload") + " Importar Excel / tabla", "import")}</div>${button("Cargar las 10 preguntas de arqueología", "demo", "text")}</div>`;
  const live = q.started !== null && q.closed === null;
  return `<div class="question-top"><span class="eyebrow">PREGUNTA ${q.position + 1} DE ${current.questions.length}</span><span class="tag ${live ? "purple" : ""}">${status(q)}</span></div><h2 class="question-title">${esc(q.title)}</h2><div class="question-meta"><span>${icon("clock")} ${q.seconds} segundos</span><span>${icon("people")} ${q.received || 0} / ${current.participants} respuestas</span></div>${q.closed !== null ? stats(q) : `<div class="option-list">${q.options.map((o, i) => `<div class="option ${i === q.correct ? "is-correct" : ""}"><span class="letter">${String.fromCharCode(65 + i)}</span><span>${esc(o)}</span>${i === q.correct ? '<span class="answer-label">✓ Correcta</span>' : ""}</div>`).join("")}</div>`}<div class="question-footer">${live ? `<div class="countdown" data-deadline="${q.deadline}"></div>${button(icon("close") + " Cerrar votación", "close", "primary", `data-id="${q.id}"`)}` : q.started === null ? `${button("Editar pregunta", "edit", "secondary", `data-id="${q.id}"`)}${button(icon("play") + " Iniciar pregunta", "start", "primary", `data-id="${q.id}" ${current.ended ? "disabled" : ""}`)}` : !q.revealed && !current.ended ? `<span class="hint">Pregunta cerrada · Los resultados siguen ocultos.</span>${button(icon("chart") + " Mostrar resultados", "reveal", "primary", `data-id="${q.id}"`)}` : `<span class="hint">Pregunta cerrada · Resultados visibles.</span>${nextButton(q)}`}</div>`;
}
function nextButton(q) {
  const next = current.questions.find((x) => x.started === null);
  return next && !current.ended
    ? button(
        "Siguiente pregunta " + icon("arrow"),
        "select",
        "primary",
        `data-id="${next.id}"`,
      )
    : "";
}
function teacher() {
  const q =
    current.questions.find((q) => q.id === selected) ||
    current.questions.at(-1);
  if (q) selected = q.id;
  const live = current.questions.find(
      (q) => q.started !== null && q.closed === null,
    ),
    link = studentLink(current.code);
  return `<main class="workspace"><div class="breadcrumb">${button("← Mis sesiones", "home", "text")}<span>/</span><span>${esc(current.title)}</span></div><div class="title-row"><div><div class="eyebrow">${current.ended ? "SESIÓN FINALIZADA" : "VISTA DEL PROFESOR"}</div><h1>${esc(current.title)}</h1></div><div class="actions"><a class="btn secondary" href="/pantalla?codigo=${current.code}" target="_blank" rel="noopener">▣ Pantalla de proyección</a><a class="btn secondary" href="${endpoint("export")}">${icon("download")} Exportar Excel</a>${!current.ended ? button("Finalizar sesión", "finish", "secondary") : ""}</div></div><section class="session-band"><div><span class="band-label">CÓDIGO PARA PARTICIPAR</span><strong class="session-code">${current.code}</strong></div><div class="join-link"><span>Entra desde móvil u ordenador</span><a href="${link}" target="_blank" rel="noopener">${esc(location.host)}/alumno</a>${button("Copiar enlace", "copy", "text")}</div><div class="teacher-qr" title="Escanear para entrar como alumno">${qrSvg(link)}</div><div class="participants"><strong>${current.participants}</strong><span>participantes</span></div><div class="connection" id="connection">Conectado</div></section><div class="workspace-grid"><aside class="question-sidebar"><div class="section-title"><h2>Preguntas</h2><span>${current.questions.length}</span></div><div class="question-nav">${current.questions.map((q) => `<button class="question-nav-item ${q.id === selected ? "selected" : ""}" data-action="select" data-id="${q.id}"><span class="number">${q.position + 1}</span><span><strong>${esc(q.title)}</strong><small>${q.seconds}s · ${status(q)}</small></span></button>`).join("") || '<p class="hint">Todavía no hay preguntas.</p>'}</div>${!current.ended ? `<div class="sidebar-actions">${button(icon("plus") + " Añadir pregunta", "add", "secondary full")}${button(icon("upload") + " Importar Excel / tabla", "import", "text full")}</div>` : ""}<div class="sidebar-note"><strong>A tu ritmo.</strong><p>Inicia cada pregunta cuando la clase esté preparada. El cierre es automático.</p></div></aside><section class="panel question-panel">${live && live.id !== selected ? `<button class="live-notice" data-action="select" data-id="${live.id}">Hay una pregunta en directo. Ver pregunta →</button>` : ""}${questionPanel(q)}</section></div>${current.ended ? overall() : ""}</main>`;
}
function overall() {
  const qs = current.questions.filter((q) => q.result),
    total = qs.reduce((s, q) => s + q.result.total, 0),
    correct = qs.reduce((s, q) => s + q.result.correctCount, 0);
  return `<section class="panel summary"><h2>Balance de la sesión</h2><div class="score-grid"><div><strong class="score good">${total ? ((100 * correct) / total).toFixed(1) : "0.0"}%</strong><span>Aciertos globales</span></div><div><strong class="score bad">${total ? ((100 * (total - correct)) / total).toFixed(1) : "0.0"}%</strong><span>Errores globales</span></div><div><strong class="score">${total}</strong><span>Respuestas recibidas</span></div></div><p class="hint">Calculado sobre todas las respuestas recibidas, sin incluir ausencias.</p></section>`;
}
function student() {
  const q = [...current.questions].sort((a, b) => b.position - a.position)[0];
  const live = q && q.closed === null;
  return `<main class="student"><div class="student-session"><span class="tag purple">SESIÓN ${current.code}</span><span>${esc(current.participant?.name)}</span></div><h1>${esc(current.title)}</h1><div id="connection" class="connection">Conectado</div><section class="panel student-question">${current.ended ? '<span class="tag green">SESIÓN FINALIZADA</span><h2>Gracias por participar.</h2>' : ""}${!q ? '<div class="waiting-mark">◷</div><h2>Ya estás dentro.</h2><p>Tu profesor iniciará la primera pregunta en un momento.</p>' : `<div class="question-top"><span class="eyebrow">PREGUNTA ${q.position + 1}</span>${live ? `<span class="countdown" data-deadline="${q.deadline}"></span>` : '<span class="tag">Cerrada</span>'}</div><h2 class="question-title">${esc(q.title)}</h2>${live ? `${q.answer !== undefined ? '<div class="answered"><strong>✓ Respuesta enviada</strong><p>Los resultados aparecerán cuando el profesor los muestre.</p></div>' : ""}<div class="student-options">${q.options.map((o, i) => `<button class="option ${q.answer === i ? "chosen" : ""}" data-action="answer" data-choice="${i}" data-id="${q.id}" ${q.answer !== undefined ? "disabled" : ""}><span class="letter">${String.fromCharCode(65 + i)}</span><span>${esc(o)}</span>${q.answer === i ? "✓" : ""}</button>`).join("")}</div><p class="hint">Pulsa una opción para enviar tu respuesta. No podrás cambiarla.</p>` : q.revealed ? stats(q) : '<div class="answered waiting-results"><strong>Votación cerrada</strong><p>El profesor mostrará los resultados en un momento.</p></div>'}`}</section>${current.ended ? overall() : ""}${button("Salir de la vista de alumno", "leave", "text")}</main>`;
}
function displayControls(q) {
  if (!current.teacher) return "";
  const next = current.questions.find((question) => question.started === null);
  let main =
    '<span class="projector-control-status">No quedan preguntas pendientes.</span>';
  if (!current.ended) {
    if (!q && next)
      main = button(
        icon("play") + " Iniciar primera pregunta",
        "start",
        "primary",
        `data-id="${next.id}"`,
      );
    else if (q?.closed === null)
      main = button(
        icon("close") + " Cerrar votación",
        "close",
        "primary",
        `data-id="${q.id}"`,
      );
    else if (q && !q.revealed)
      main = button(
        icon("chart") + " Mostrar resultados",
        "reveal",
        "primary",
        `data-id="${q.id}"`,
      );
    else if (next)
      main = button(
        "Iniciar siguiente pregunta " + icon("arrow"),
        "start",
        "primary",
        `data-id="${next.id}"`,
      );
  }
  return `<section class="projector-controls" aria-label="Controles del profesor"><span class="eyebrow">CONTROLES DEL PROFESOR</span><div class="actions">${main}${!current.ended ? button("Finalizar sesión", "finish", "secondary") : '<span class="tag green">SESIÓN FINALIZADA</span>'}</div></section>`;
}
function display() {
  const q = [...current.questions]
      .filter((question) => question.started !== null)
      .sort((a, b) => b.position - a.position)[0],
    live = q && q.closed === null,
    link = studentLink(current.code),
    contentLength = q
      ? q.title.length +
        q.options.reduce((sum, option) => sum + option.length, 0)
      : 0,
    density =
      contentLength > 900
        ? "projector-very-dense"
        : contentLength > 500
          ? "projector-dense"
          : contentLength > 280
            ? "projector-compact"
            : "";
  const phase = !q
    ? `<div class="projector-wait"><span class="waiting-mark">◷</span><h2>Esperando la primera pregunta</h2><p>Escanea el código QR o entra con el código de sesión.</p></div>`
    : `<div class="question-top"><span class="eyebrow">PREGUNTA ${q.position + 1}</span>${live ? `<span class="countdown" data-deadline="${q.deadline}"></span>` : q.revealed ? '<span class="tag green">RESULTADOS</span>' : '<span class="tag">VOTACIÓN CERRADA</span>'}</div><h2 class="projector-question">${esc(q.title)}</h2>${live ? `<div class="projector-options">${q.options.map((o, i) => `<div class="option"><span class="letter">${String.fromCharCode(65 + i)}</span><span>${esc(o)}</span></div>`).join("")}</div><div class="projector-response-count">${q.received || 0} respuestas recibidas</div>` : q.revealed ? stats(q) : `<div class="projector-options">${q.options.map((o, i) => `<div class="option"><span class="letter">${String.fromCharCode(65 + i)}</span><span>${esc(o)}</span></div>`).join("")}</div><div class="projector-closed-note">Votación cerrada · Resultados pendientes</div>`}`;
  return `<main class="projector ${current.teacher ? "teacher-projector" : ""}"><section class="projector-heading"><div><span class="eyebrow">${current.ended ? "SESIÓN FINALIZADA" : "SESIÓN EN DIRECTO"}</span><h1>${esc(current.title)}</h1></div><div class="projector-people"><strong>${current.participants}</strong><span>participantes</span><div id="connection" class="connection">Conectado</div></div></section>${displayControls(q)}<div class="projector-grid"><section class="panel projector-content ${density}">${phase}</section><aside class="panel projector-join"><span class="eyebrow">PARTICIPA CON TU MÓVIL</span><div class="projector-qr">${qrSvg(link)}</div><span class="band-label">CÓDIGO DE SESIÓN</span><strong class="session-code">${current.code}</strong><p>${esc(location.host)}/alumno</p></aside></div></main>`;
}
function displayMissing() {
  return `<main class="projector"><section class="panel projector-content projector-wait"><h1>Falta el código de sesión</h1><p>Abre la pantalla de proyección desde la vista del profesor.</p></section></main>`;
}
function render() {
  const focus = document.activeElement?.id;
  const content =
    role === "display"
      ? current
        ? display()
        : displayMissing()
      : current
        ? role === "teacher"
          ? teacher()
          : student()
        : role === "teacher"
          ? resetToken || !authState.authenticated
            ? authPage()
            : home()
          : join();
  $("#app").innerHTML = header() + content;
  if (focus) document.getElementById(focus)?.focus();
  tick();
  if (role === "display") requestAnimationFrame(fitProjection);
}
function fitProjection() {
  const content = $(".projector-content");
  if (!content) return;
  content.classList.remove("projection-tight");
  const text = [
    content.querySelector(".projector-question"),
    ...content.querySelectorAll(".projector-options .option, .bar-label"),
  ].filter(Boolean);
  for (const element of text) element.style.fontSize = "";
  if (content.scrollHeight <= content.clientHeight) return;
  content.classList.add("projection-tight");
  const sizes = text.map((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  let factor = 0.96;
  while (content.scrollHeight > content.clientHeight && factor >= 0.55) {
    text.forEach((element, index) => {
      element.style.fontSize = `${Math.max(12, sizes[index] * factor)}px`;
    });
    factor -= 0.04;
  }
}
function pollDelay() {
  const live = current?.questions?.some(
    (q) => q.started !== null && q.closed === null,
  );
  return live ? 2000 : 5000;
}
function tick() {
  const now = Date.now() + serverOffset;
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    const seconds = Math.max(
      0,
      Math.ceil((Number(el.dataset.deadline) - now) / 1000),
    );
    el.textContent = seconds ? `${seconds}s` : "Tiempo agotado";
    el.classList.toggle("urgent", seconds <= 5);
    if (!seconds)
      document
        .querySelectorAll('[data-action="answer"]')
        .forEach((b) => (b.disabled = true));
  });
  const stale = last && Date.now() - last > pollDelay() * 2 + 5000;
  const el = $("#connection");
  if (el) {
    el.textContent = stale ? "Reconectando…" : "Conectado";
    el.classList.toggle("offline", !!stale);
  }
  if (stale)
    document
      .querySelectorAll('[data-action="answer"],[data-action="start"]')
      .forEach((b) => (b.disabled = true));
}
async function refresh() {
  if (!current || busy) return;
  const code = current.code,
    view = role;
  try {
    const route =
        view === "display"
          ? `/api/sessions/${code}/display`
          : `/api/sessions/${code}?role=${view}`,
      data = await api(route);
    if (current?.code !== code || role !== view) return;
    last = Date.now();
    const sig = JSON.stringify({ ...data, serverNow: 0 });
    current = data;
    if (sig !== signature) {
      signature = sig;
      render();
    } else if ($("#connection")?.classList.contains("offline")) render();
  } catch {
    tick();
  }
}
function scheduleRefresh(delay = pollDelay()) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, delay);
}
async function poll() {
  await refresh();
  scheduleRefresh();
}
function modal(title, content) {
  $("#modal").innerHTML =
    `<div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-action="dismiss" aria-label="Cerrar">×</button></div>${content}<div id="form-error" class="form-error" role="alert"></div>`;
  $("#modal").showModal();
}
function fields(
  q = { title: "", options: ["", "", "", ""], correct: 0, seconds: 30 },
  prefix = "",
) {
  return `<label>Pregunta<textarea name="${prefix}title" required maxlength="2000" rows="2">${esc(q.title)}</textarea></label><div class="field-row"><label>Tiempo (segundos)<input name="${prefix}seconds" type="number" min="5" max="3600" required value="${q.seconds}"></label><label>Respuesta correcta<select name="${prefix}correct">${q.options.map((_, i) => `<option value="${i}" ${q.correct === i ? "selected" : ""}>Opción ${String.fromCharCode(65 + i)}</option>`).join("")}</select></label></div><div class="option-fields">${q.options.map((o, i) => `<label>Opción ${String.fromCharCode(65 + i)}<input name="${prefix}option${i}" value="${esc(o)}" maxlength="1000" required></label>`).join("")}</div>`;
}
function questionForm(q) {
  modal(
    q ? "Editar pregunta" : "Nueva pregunta",
    `<form id="question-form" data-id="${q?.id || ""}" data-count="${q?.options.length || 4}">${fields(q)}<p class="hint">Selecciona una única respuesta correcta.</p><button class="btn primary full" type="submit">Guardar pregunta</button></form>`,
  );
}
function extract(form, prefix = "", count = 4) {
  const d = new FormData(form);
  return {
    title: d.get(prefix + "title"),
    seconds: Number(d.get(prefix + "seconds")),
    correct: Number(d.get(prefix + "correct")),
    options: Array.from({ length: count }, (_, i) =>
      d.get(prefix + "option" + i),
    ),
  };
}
function importModal() {
  modal(
    "Importar preguntas",
    `<form id="import-form"><p>Una pregunta por columna, con las filas <b>Question:</b>, <b>Choices:</b> y <b>Correct answers:</b>. Las columnas vacías se ignoran.</p><label class="file-zone">${icon("upload")} Seleccionar Excel (.xlsx)<input type="file" name="file" accept=".xlsx"></label><div class="divider">o pega tu tabla</div><label>Tabla copiada desde Excel o Markdown<textarea name="text" rows="6" placeholder="Question:    Pregunta 1    Pregunta 2&#10;Choices:      1. ...             1. ...&#10;Correct answers:  2. ...    1. ..."></textarea></label><label>Tiempo inicial por pregunta (segundos)<input type="number" name="seconds" min="5" max="3600" value="30" required></label><p class="hint">Se admiten saltos de línea y &lt;br&gt; entre opciones. La fila opcional Time: permite tiempos diferentes. Podrás revisarlo todo antes de guardar.</p><div class="actions"><a class="btn secondary" href="/api/template" download="plantilla-pulso.xlsx">Descargar plantilla</a><button type="submit" class="btn primary">Revisar preguntas →</button></div></form>`,
  );
}
function review(data) {
  stage = data;
  modal(
    `Revisar ${data.questions.length} preguntas`,
    `<form id="review-form">${data.warnings.map((w) => `<p class="warning">${esc(w)}</p>`).join("")}<p>Comprueba las opciones, la respuesta correcta y el tiempo antes de añadirlas.</p>${data.questions.map((q, i) => `<fieldset class="review-question"><legend>Pregunta ${i + 1}</legend>${fields(q, `q${i}_`)}</fieldset>`).join("")}<button class="btn primary full" type="submit">Añadir ${data.questions.length} preguntas a la sesión</button></form>`,
  );
}
const demo = [
  [
    '¿Qué es un yacimiento en posición autóctona ("in situ")?',
    [
      "Un yacimiento que ha sido alterado por procesos posdeposicionales.",
      "Un yacimiento que ha sido alterado por procesos posdeposicionales.",
      "Un yacimiento que se encuentra en una cueva.",
      "Un yacimiento donde los restos arqueológicos se encuentran en su posición original.",
    ],
    3,
  ],
  [
    "¿Cuál de los siguientes NO es un proceso posdeposicional que puede afectar a un yacimiento arqueológico?",
    ["Pisoteo", "Fosilización", "Acción de carnívoros", "Crioturbación"],
    1,
  ],
  [
    "¿Qué es el registro arqueológico?",
    [
      "Solo restos líticos tallados.",
      "Solo fósiles de fauna.",
      "Conjunto de residuos materiales del pasado.",
      "Solo estructuras de hábitat.",
    ],
    2,
  ],
  [
    "En medios fluviales, la llanura de inundación corresponde a…",
    [
      "Canal activo de alta energía.",
      "Zona de depósito en crecidas, “vega”.",
      "Terraza alta abandonada.",
      "Lecho rocoso.",
    ],
    1,
  ],
  [
    "Una terraza fluvial es…",
    [
      "Un dique artificial.",
      "Una superficie escalonada, resto de antiguos niveles de río.",
      "Un abanico aluvial activo.",
      "Un delta marino.",
    ],
    1,
  ],
  [
    "En el esquema de funcionalidad (Isaac), un nivel con solo industria lítica puede interpretarse como…",
    [
      "Área de captación o “taller”.",
      "Depósito transportado.",
      "Yacimiento paleontológico.",
      "Matanza múltiple de varias especies.",
    ],
    0,
  ],
  [
    "La escorrentía superficial previa al enterramiento produce…",
    [
      "Cementación inmediata.",
      "Reorganización y desplazamiento de artefactos.",
      "Fosilización instantánea.",
      "Orientación perfecta al norte.",
    ],
    1,
  ],
  [
    "El pisoteo (trampling) humano o animal puede…",
    [
      "Aumentar el tamaño de las piezas.",
      "Desplazar, voltear y fragmentar artefactos.",
      "Consolidar sedimentos en cemento.",
      "Generar marcas de corte.",
    ],
    1,
  ],
  [
    "La bioturbación (orgánica) en cuevas puede…",
    [
      "Formar terrazas.",
      "Alterar estratigrafía por madrigueras.",
      "Crear diaclasas tectónicas.",
      "Producir dolinas.",
    ],
    1,
  ],
  [
    "La tafonomía estudia…",
    [
      "Solo tecnología lítica.",
      "Procesos que afectan restos desde la muerte hasta su hallazgo.",
      "Únicamente cronología radiocarbónica.",
      "Solo micromorfología.",
    ],
    1,
  ],
];
async function perform(action, el) {
  switch (action) {
    case "teacher":
      role = "teacher";
      current = null;
      history.replaceState({}, "", "/");
      applyBootstrap(await api("/api/bootstrap"));
      break;
    case "student":
      role = "student";
      current = null;
      history.replaceState({}, "", "/alumno");
      break;
    case "forgot-password":
      authView = "forgot";
      resetRequested = false;
      break;
    case "auth-home":
      authView = "default";
      resetRequested = false;
      resetToken = "";
      history.replaceState({}, "", "/");
      break;
    case "create":
      modal(
        "Nueva sesión",
        `<form id="create-form"><label>Nombre de la sesión<input name="title" required maxlength="120" placeholder="Por ejemplo, Arqueología · Tema 1"></label><button type="submit" class="btn primary full">Crear sesión</button></form>`,
      );
      return;
    case "open":
      current = await api(`/api/sessions/${el.dataset.code}`);
      selected = current.questions[0]?.id;
      last = Date.now();
      break;
    case "duplicate": {
      const copy = await api(`/api/sessions/${el.dataset.code}/duplicate`, {});
      applyBootstrap(await api("/api/bootstrap"));
      notify(`Sesión duplicada: ${copy.title}`);
      break;
    }
    case "ask-delete": {
      const session = sessions.find((s) => s.code === el.dataset.code);
      modal(
        "Eliminar sesión",
        `<p>Vas a eliminar <strong>${esc(session?.title || "esta sesión")}</strong>. También se borrarán definitivamente sus preguntas, participantes y respuestas.</p><div class="actions">${button("Cancelar", "dismiss", "secondary")}${button("Eliminar definitivamente", "confirm-delete", "danger", `data-code="${el.dataset.code}"`)}</div>`,
      );
      return;
    }
    case "confirm-delete":
      await api(`/api/sessions/${el.dataset.code}/delete`, {});
      $("#modal").close();
      applyBootstrap(await api("/api/bootstrap"));
      notify("Sesión eliminada");
      break;
    case "home":
      current = null;
      applyBootstrap(await api("/api/bootstrap"));
      break;
    case "logout":
      applyBootstrap(await api("/api/auth/logout", {}));
      history.replaceState({}, "", "/");
      notify("Sesión cerrada");
      break;
    case "select":
      selected = el.dataset.id;
      break;
    case "add":
      questionForm();
      return;
    case "edit":
      questionForm(current.questions.find((q) => q.id === el.dataset.id));
      return;
    case "import":
      importModal();
      return;
    case "demo":
      review({
        questions: demo.map(([title, options, correct]) => ({
          title,
          options,
          correct,
          seconds: 30,
        })),
        warnings: [
          "Pregunta 1: las opciones A y B están repetidas en tu ejemplo. Se conservan para que puedas revisarlas.",
        ],
      });
      return;
    case "dismiss":
      $("#modal").close();
      return;
    case "start":
    case "close":
    case "reveal":
      current = await api(endpoint(action), { id: el.dataset.id });
      last = Date.now();
      break;
    case "finish":
      modal(
        "Finalizar sesión",
        `<p>Se cerrará la pregunta abierta y no se admitirán más respuestas. Después podrás descargar los resultados en Excel.</p>${button("Finalizar y ver resumen", "confirm-finish", "primary full")}`,
      );
      return;
    case "confirm-finish":
      current = await api(endpoint("finish"), {});
      $("#modal").close();
      break;
    case "answer":
      await api(endpoint("answer"), {
        question: el.dataset.id,
        choice: Number(el.dataset.choice),
      });
      current = await api(`/api/sessions/${current.code}?role=student`);
      last = Date.now();
      notify("Respuesta enviada");
      break;
    case "copy":
      try {
        await navigator.clipboard.writeText(
          `${location.origin}/alumno?codigo=${current.code}`,
        );
        notify("Enlace copiado");
      } catch {
        modal(
          "Enlace para alumnos",
          `<label>Copia este enlace<input readonly value="${esc(location.origin)}/alumno?codigo=${current.code}"></label>`,
        );
      }
      return;
    case "leave":
      current = null;
      break;
  }
  signature = "";
  render();
}
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || busy || el.disabled) return;
  busy = true;
  el.disabled = true;
  try {
    await perform(el.dataset.action, el);
  } catch (err) {
    notify(err.message, true);
  } finally {
    busy = false;
    el.disabled = false;
    tick();
    scheduleRefresh(500);
  }
});
document.addEventListener("submit", async (e) => {
  const form = e.target;
  e.preventDefault();
  if (busy) return;
  busy = true;
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  const d = new FormData(form);
  try {
    if (form.id === "password-request-form") {
      await api("/api/auth/password/request", { email: d.get("email") });
      resetRequested = true;
      notify("Solicitud recibida. Comprueba tu correo.");
    }
    if (form.id === "reset-password-form") {
      if (d.get("password") !== d.get("confirm"))
        throw Error("Las dos contraseñas no coinciden.");
      const salt = passwordSalt();
      applyBootstrap(
        await api("/api/auth/password/reset", {
          token: resetToken,
          salt,
          proof: await derivePassword(String(d.get("password")), salt),
        }),
      );
      resetToken = "";
      authView = "default";
      history.replaceState({}, "", "/");
      notify("Contraseña actualizada. Ya has iniciado sesión.");
    }
    if (form.id === "login-form") {
      const email = String(d.get("email")).trim().toLowerCase();
      const { salt } = await api(
        `/api/auth/salt?email=${encodeURIComponent(email)}`,
      );
      applyBootstrap(
        await api("/api/auth/login", {
          email,
          proof: await derivePassword(String(d.get("password")), salt),
        }),
      );
      notify("Sesión iniciada");
    }
    if (form.id === "register-form") {
      if (d.get("password") !== d.get("confirm"))
        throw Error("Las dos contraseñas no coinciden.");
      const salt = passwordSalt();
      applyBootstrap(
        await api("/api/auth/register", {
          email: d.get("email"),
          salt,
          proof: await derivePassword(String(d.get("password")), salt),
        }),
      );
      notify("Cuenta creada. Tus encuestas ya están vinculadas.");
    }
    if (form.id === "create-form") {
      const { code } = await api("/api/sessions", { title: d.get("title") });
      current = await api(`/api/sessions/${code}`);
      selected = null;
      $("#modal").close();
    }
    if (form.id === "join-form") {
      joinCode = String(d.get("code"));
      current = await api(`/api/sessions/${joinCode}/join`, {
        name: d.get("name"),
      });
      last = Date.now();
    }
    if (form.id === "question-form") {
      const q = extract(form, "", Number(form.dataset.count));
      current = await api(
        endpoint(form.dataset.id ? "edit" : "questions"),
        form.dataset.id ? { ...q, id: form.dataset.id } : { questions: [q] },
      );
      selected = form.dataset.id || current.questions.at(-1).id;
      $("#modal").close();
    }
    if (form.id === "import-form") {
      const file = d.get("file");
      const body = { seconds: Number(d.get("seconds")), text: d.get("text") };
      if (file.size) {
        if (file.size > 5e6) throw Error("El archivo supera los 5 MB.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        body.file = btoa(binary);
      }
      review(await api("/api/import", body));
      return;
    }
    if (form.id === "review-form") {
      const questions = stage.questions.map((q, i) =>
        extract(form, `q${i}_`, q.options.length),
      );
      current = await api(endpoint("questions"), { questions });
      selected = current.questions.at(-questions.length).id;
      $("#modal").close();
      notify(`${questions.length} preguntas añadidas`);
    }
    signature = "";
    render();
  } catch (err) {
    const target = $("#form-error");
    if (target && $("#modal").open) target.textContent = err.message;
    else notify(err.message, true);
  } finally {
    busy = false;
    if (submit) submit.disabled = false;
    scheduleRefresh(500);
  }
});
async function init() {
  try {
    if (role === "display") {
      if (/^\d{6}$/.test(joinCode)) {
        current = await api(`/api/sessions/${joinCode}/display`);
        last = Date.now();
      }
    } else applyBootstrap(await api("/api/bootstrap"));
  } catch (e) {
    notify(e.message, true);
  }
  render();
  scheduleRefresh(1000);
  setInterval(tick, 200);
  if (role === "display") return;
  const ctx = document.modelContext;
  if (ctx?.registerTool) {
    const controller = new AbortController();
    try {
      await ctx.registerTool(
        {
          name: "get_classroom_session",
          title: "Ver sesión actual",
          description:
            "Devuelve el estado visible de la sesión actual sin iniciar ni cerrar preguntas.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (!input || Object.keys(input).length)
              throw Error("No se admiten parámetros.");
            await refresh();
            return current || { sessions };
          },
        },
        { signal: controller.signal },
      );
      addEventListener("pagehide", () => controller.abort(), { once: true });
    } catch {}
  }
}
init();
addEventListener("resize", () => {
  if (role === "display") fitProjection();
});
