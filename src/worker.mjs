import {Buffer} from 'node:buffer';
import {workbook, readWorkbook} from '../lib/excel.mjs';
import {importQuestions, parseTable} from '../lib/import.mjs';

const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
};

class Problem extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const requireValue = (value, message, status = 400) => {
  if (!value) throw new Problem(message, status);
};

const token = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
};

const parseCookies = request =>
  Object.fromEntries(
    (request.headers.get('Cookie') || '')
      .split(';')
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => {
        const separator = value.indexOf('=');
        return separator < 0 ? [value, ''] : [value.slice(0, separator), value.slice(separator + 1)];
      })
  );

const apiResponse = (data, status = 200, headers = {}) => {
  const responseHeaders = new Headers({...securityHeaders, ...headers});
  if (!responseHeaders.has('Content-Type')) responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  const body = responseHeaders.get('Content-Type').startsWith('application/json') ? JSON.stringify(data) : data;
  return new Response(body, {status, headers: responseHeaders});
};

const addCookie = (response, name, value, secure = true) => {
  response.headers.append('Set-Cookie', `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure ? '; Secure' : ''}`);
  return response;
};

const first = async (db, sql, ...params) =>
  db
    .prepare(sql)
    .bind(...params)
    .first();
const all = async (db, sql, ...params) =>
  (
    await db
      .prepare(sql)
      .bind(...params)
      .all()
  ).results;
const run = async (db, sql, ...params) =>
  db
    .prepare(sql)
    .bind(...params)
    .run();

function validateQuestion(question) {
  requireValue(question && typeof question.title === 'string' && question.title.trim().length > 0 && question.title.length <= 2000, 'Escribe una pregunta (máximo 2000 caracteres).');
  requireValue(Array.isArray(question.options) && question.options.length >= 2 && question.options.length <= 8 && question.options.every(option => typeof option === 'string' && option.trim() && option.length <= 1000), 'Introduce entre 2 y 8 opciones.');
  requireValue(Number.isInteger(question.correct) && question.correct >= 0 && question.correct < question.options.length, 'Marca una respuesta correcta.');
  requireValue(Number.isInteger(question.seconds) && question.seconds >= 5 && question.seconds <= 3600, 'El tiempo debe estar entre 5 y 3600 segundos.');
  return {
    ...question,
    title: question.title.trim(),
    options: question.options.map(option => option.trim())
  };
}

function resultFor(question, answerRows) {
  const options = JSON.parse(question.options);
  const counts = options.map((_, index) => Number(answerRows.find(row => row.question === question.id && Number(row.choice) === index)?.count || 0));
  const total = counts.reduce((sum, value) => sum + value, 0);
  return {
    counts,
    total,
    percentages: counts.map(value => (total ? (100 * value) / total : 0)),
    correctCount: counts[question.correct],
    correctPercent: total ? (100 * counts[question.correct]) / total : 0,
    errorPercent: total ? (100 * (total - counts[question.correct])) / total : 0
  };
}

async function expire(db, code, now) {
  await run(db, 'UPDATE questions SET closed=started+seconds*1000 WHERE code=? AND started IS NOT NULL AND closed IS NULL AND started+seconds*1000<=?', code, now);
}

async function session(db, code, now) {
  await expire(db, code, now);
  const value = await first(db, 'SELECT * FROM sessions WHERE code=?', code);
  requireValue(value, 'No encontramos esa sesión.', 404);
  return value;
}

async function owned(db, code, owner, now) {
  const value = await session(db, code, now);
  requireValue(value.owner === owner, 'Esta sesión pertenece a otro profesor.', 403);
  return value;
}

async function state(db, code, owner, participantId, now) {
  const currentSession = await session(db, code, now);
  const statements = [db.prepare('SELECT * FROM participants WHERE id=? AND code=?').bind(participantId || '', code), db.prepare('SELECT * FROM questions WHERE code=? ORDER BY position').bind(code), db.prepare('SELECT count(*) AS n FROM participants WHERE code=?').bind(code), db.prepare('SELECT a.question, a.choice, count(*) AS count FROM answers a JOIN questions q ON q.id=a.question WHERE q.code=? GROUP BY a.question,a.choice').bind(code), db.prepare('SELECT a.question,a.choice FROM answers a JOIN questions q ON q.id=a.question WHERE a.participant=? AND q.code=?').bind(participantId || '', code)];
  const [participantResult, questionsResult, participantsResult, countsResult, choicesResult] = await db.batch(statements);
  const participant = participantResult.results[0] || null;
  const teacher = currentSession.owner === owner;
  requireValue(teacher || participant, 'Entra en la sesión para continuar.', 401);
  let questions = questionsResult.results;
  if (!teacher) questions = questions.filter(question => question.started !== null);
  const participantChoices = new Map(choicesResult.results.map(answer => [answer.question, Number(answer.choice)]));
  return {
    code: currentSession.code,
    title: currentSession.title,
    ended: Boolean(currentSession.ended),
    serverNow: now,
    teacher,
    participant: participant ? {name: participant.name, id: participant.id} : null,
    participants: Number(participantsResult.results[0]?.n || 0),
    questions: questions.map(question => {
      const closed = question.closed !== null;
      const revealed = Boolean(question.revealed);
      return {
        id: question.id,
        title: question.title,
        options: JSON.parse(question.options),
        seconds: Number(question.seconds),
        position: Number(question.position),
        started: question.started,
        deadline: question.started === null ? null : Number(question.started) + Number(question.seconds) * 1000,
        closed: question.closed,
        revealed,
        correct: teacher || revealed ? Number(question.correct) : undefined,
        answer: participantChoices.has(question.id) ? participantChoices.get(question.id) : undefined,
        received: teacher || revealed ? countsResult.results.filter(row => row.question === question.id).reduce((sum, row) => sum + Number(row.count), 0) : undefined,
        result: (teacher && closed) || revealed ? resultFor(question, countsResult.results) : undefined
      };
    })
  };
}

async function displayState(db, code, owner, now) {
  const currentSession = await session(db, code, now);
  const teacher = Boolean(owner && currentSession.owner === owner);
  const [questionsResult, participantsResult, countsResult] = await db.batch([db.prepare(`SELECT * FROM questions WHERE code=?${teacher ? '' : ' AND started IS NOT NULL'} ORDER BY position`).bind(code), db.prepare('SELECT count(*) AS n FROM participants WHERE code=?').bind(code), db.prepare('SELECT a.question, a.choice, count(*) AS count FROM answers a JOIN questions q ON q.id=a.question WHERE q.code=? GROUP BY a.question,a.choice').bind(code)]);
  const counts = countsResult.results;
  return {
    code: currentSession.code,
    title: currentSession.title,
    ended: Boolean(currentSession.ended),
    display: true,
    teacher,
    serverNow: now,
    participants: Number(participantsResult.results[0]?.n || 0),
    questions: questionsResult.results.map(question => {
      const revealed = Boolean(question.revealed);
      return {
        id: question.id,
        title: question.title,
        options: JSON.parse(question.options),
        seconds: Number(question.seconds),
        position: Number(question.position),
        started: question.started,
        deadline: question.started === null ? null : Number(question.started) + Number(question.seconds) * 1000,
        closed: question.closed,
        revealed,
        correct: revealed ? Number(question.correct) : undefined,
        received: counts.filter(row => row.question === question.id).reduce((sum, row) => sum + Number(row.count), 0),
        result: revealed ? resultFor(question, counts) : undefined
      };
    })
  };
}

async function parseBody(request) {
  const text = await request.text();
  requireValue(text.length <= 8_000_000, 'Archivo demasiado grande (máximo 5 MB).', 413);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Problem('Solicitud JSON no válida.');
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const now = Date.now();
  const cookies = parseCookies(request);
  let owner = cookies.pulso_teacher;
  const secure = url.protocol === 'https:';

  if (request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (origin) requireValue(new URL(origin).origin === url.origin, 'Origen no permitido.', 403);
  }
  const body = request.method === 'POST' ? await parseBody(request) : {};

  if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
    let fresh = false;
    if (!owner || !/^[a-f0-9]{48}$/.test(owner)) {
      owner = token();
      fresh = true;
    }
    const sessions = await all(env.DB, 'SELECT code,title,created,ended FROM sessions WHERE owner=? ORDER BY created DESC', owner);
    const response = apiResponse({sessions, serverNow: now});
    return fresh ? addCookie(response, 'pulso_teacher', owner, secure) : response;
  }

  if (url.pathname === '/api/sessions' && request.method === 'POST') {
    requireValue(owner, 'Recarga la página para crear una sesión.', 401);
    const title = String(body.title || '').trim();
    requireValue(title && title.length <= 120, 'Escribe un título de hasta 120 caracteres.');
    let code;
    for (let attempt = 0; attempt < 20; attempt++) {
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      code = String((random[0] % 900000) + 100000);
      if (!(await first(env.DB, 'SELECT code FROM sessions WHERE code=?', code))) break;
      code = null;
    }
    requireValue(code, 'No se ha podido generar un código. Inténtalo de nuevo.', 503);
    await run(env.DB, 'INSERT INTO sessions(code,owner,title,created) VALUES(?,?,?,?)', code, owner, title, now);
    return apiResponse({code}, 201);
  }

  if (url.pathname === '/api/import' && request.method === 'POST') {
    try {
      const sheets = body.file ? readWorkbook(Buffer.from(body.file, 'base64')) : [parseTable(String(body.text || ''))];
      let parsed;
      let error;
      for (const rows of sheets) {
        try {
          parsed = importQuestions(rows, Number(body.seconds || 30));
          break;
        } catch (caught) {
          error = caught;
        }
      }
      if (!parsed) throw error;
      parsed.questions.forEach(validateQuestion);
      return apiResponse(parsed);
    } catch (error) {
      throw new Problem(error.message);
    }
  }

  if (url.pathname === '/api/template' && request.method === 'GET') {
    const file = workbook([
      {
        name: 'Plantilla',
        rows: [
          ['Question:', '', '', '¿Qué es el registro arqueológico?'],
          ['Choices:', '', '', '1. Solo restos líticos\n2. Solo fósiles\n3. Conjunto de residuos materiales del pasado\n4. Solo estructuras'],
          ['Correct answers:', '', '', '3. Conjunto de residuos materiales del pasado'],
          ['Time:', '', '', 30]
        ]
      }
    ]);
    return apiResponse(file, 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="plantilla-pulso.xlsx"'
    });
  }

  const route = /^\/api\/sessions\/(\d{6})(?:\/(.*))?$/.exec(url.pathname);
  if (!route) throw new Problem('Ruta no encontrada.', 404);
  const [, code, action = ''] = route;
  const participantId = cookies[`pulso_${code}`];

  if (action === 'display' && request.method === 'GET') {
    return apiResponse(await displayState(env.DB, code, owner, now));
  }

  if (action === 'join' && request.method === 'POST') {
    const currentSession = await session(env.DB, code, now);
    requireValue(!currentSession.ended, 'La sesión ya ha finalizado.');
    if (participantId && (await first(env.DB, 'SELECT id FROM participants WHERE id=? AND code=?', participantId, code))) {
      return apiResponse(await state(env.DB, code, null, participantId, now));
    }
    const name = String(body.name || '')
      .trim()
      .replace(/\s+/g, ' ');
    requireValue(name && name.length <= 60, 'Escribe un nombre o identificador de hasta 60 caracteres.');
    requireValue(!(await first(env.DB, 'SELECT id FROM participants WHERE code=? AND name=? COLLATE NOCASE', code, name)), 'Ese identificador ya está en uso. Añade tu apellido o un número.', 409);
    const id = token();
    try {
      await run(env.DB, 'INSERT INTO participants(id,code,name,joined) VALUES(?,?,?,?)', id, code, name, now);
    } catch {
      throw new Problem('Ese identificador ya está en uso. Añade tu apellido o un número.', 409);
    }
    return addCookie(apiResponse(await state(env.DB, code, null, id, now)), `pulso_${code}`, id, secure);
  }

  if (action === '' && request.method === 'GET') {
    return apiResponse(await state(env.DB, code, url.searchParams.get('role') === 'student' ? null : owner, participantId, now));
  }

  if (action === 'answer' && request.method === 'POST') {
    await session(env.DB, code, now);
    requireValue(participantId && (await first(env.DB, 'SELECT id FROM participants WHERE id=? AND code=?', participantId, code)), 'Entra antes de responder.', 401);
    const question = await first(env.DB, 'SELECT * FROM questions WHERE id=? AND code=?', String(body.question), code);
    requireValue(question && question.started !== null && question.closed === null && now < Number(question.started) + Number(question.seconds) * 1000, 'La pregunta está cerrada.', 409);
    requireValue(Number.isInteger(body.choice) && body.choice >= 0 && body.choice < JSON.parse(question.options).length, 'Opción no válida.');
    requireValue(!(await first(env.DB, 'SELECT choice FROM answers WHERE question=? AND participant=?', question.id, participantId)), 'Ya has enviado tu respuesta.', 409);
    try {
      await run(env.DB, 'INSERT INTO answers(question,participant,choice,created,elapsed) VALUES(?,?,?,?,?)', question.id, participantId, body.choice, now, now - Number(question.started));
    } catch {
      throw new Problem('Ya has enviado tu respuesta.', 409);
    }
    return apiResponse({saved: true});
  }

  const currentSession = await owned(env.DB, code, owner, now);

  if (action === 'duplicate' && request.method === 'POST') {
    const questions = await all(env.DB, 'SELECT position,title,options,correct,seconds FROM questions WHERE code=? ORDER BY position', code);
    let copyCode;
    for (let attempt = 0; attempt < 20; attempt++) {
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      copyCode = String((random[0] % 900000) + 100000);
      if (!(await first(env.DB, 'SELECT code FROM sessions WHERE code=?', copyCode))) break;
      copyCode = null;
    }
    requireValue(copyCode, 'No se ha podido generar un código para la copia. Inténtalo de nuevo.', 503);
    const copyTitle = `Copia de ${currentSession.title}`.slice(0, 120);
    const statements = [env.DB.prepare('INSERT INTO sessions(code,owner,title,created) VALUES(?,?,?,?)').bind(copyCode, owner, copyTitle, now)];
    for (let start = 0; start < questions.length; start += 14) {
      const chunk = questions.slice(start, start + 14);
      const placeholders = chunk.map(() => '(?,?,?,?,?,?,?)').join(',');
      const params = chunk.flatMap(question => [token(), copyCode, Number(question.position), question.title, question.options, Number(question.correct), Number(question.seconds)]);
      statements.push(env.DB.prepare(`INSERT INTO questions(id,code,position,title,options,correct,seconds) VALUES ${placeholders}`).bind(...params));
    }
    await env.DB.batch(statements);
    return apiResponse({code: copyCode, title: copyTitle}, 201);
  }

  if (action === 'export' && request.method === 'GET') {
    const [questionResults, participantResults, answerResults] = await env.DB.batch([env.DB.prepare('SELECT * FROM questions WHERE code=? ORDER BY position').bind(code), env.DB.prepare('SELECT * FROM participants WHERE code=? ORDER BY joined').bind(code), env.DB.prepare('SELECT a.* FROM answers a JOIN questions q ON q.id=a.question WHERE q.code=?').bind(code)]);
    const questions = questionResults.results;
    const participants = participantResults.results;
    const answers = answerResults.results;
    const correct = answers.filter(answer => Number(questions.find(question => question.id === answer.question).correct) === Number(answer.choice)).length;
    const total = answers.length;
    const summary = [
      ['Métrica', 'Valor'],
      ['Sesión', currentSession.title],
      ['Código', code],
      ['Estado', currentSession.ended ? 'Finalizada' : 'En curso'],
      ['Participantes', participants.length],
      ['Preguntas', questions.length],
      ['Respuestas', total],
      ['Aciertos', correct],
      ['Errores', total - correct],
      ['Aciertos (%)', total ? (100 * correct) / total : 0],
      ['Errores (%)', total ? (100 * (total - correct)) / total : 0],
      ['Cálculo', 'Porcentajes sobre respuestas recibidas; las ausencias no cuentan como errores.']
    ];
    const grouped = [];
    for (const answer of answers) {
      const found = grouped.find(row => row.question === answer.question && Number(row.choice) === Number(answer.choice));
      if (found) found.count++;
      else
        grouped.push({
          question: answer.question,
          choice: Number(answer.choice),
          count: 1
        });
    }
    const questionRows = [
      ['Nº', 'Pregunta', 'Opciones', 'Correcta', 'Tiempo configurado (s)', 'Estado', 'Respuestas', 'Aciertos (%)', 'Errores (%)'],
      ...questions.map(question => {
        const result = resultFor(question, grouped);
        const options = JSON.parse(question.options);
        return [Number(question.position) + 1, question.title, options.map((option, index) => `${index + 1}. ${option}`).join('\n'), options[question.correct], Number(question.seconds), question.closed !== null ? 'Cerrada' : question.started !== null ? 'Abierta' : 'Pendiente', result.total, result.correctPercent, result.errorPercent];
      })
    ];
    const responses = [['Identificador', 'Participante', 'Nº pregunta', 'Pregunta', 'Respuesta', 'Evaluación', 'Tiempo de respuesta (s)', 'Fecha UTC']];
    for (const question of questions.filter(value => value.started !== null)) {
      for (const participant of participants) {
        const answer = answers.find(value => value.question === question.id && value.participant === participant.id);
        responses.push([participant.id, participant.name, Number(question.position) + 1, question.title, answer ? JSON.parse(question.options)[answer.choice] : '', answer ? (Number(answer.choice) === Number(question.correct) ? 'Correcta' : 'Incorrecta') : 'Sin respuesta', answer ? Number(answer.elapsed) / 1000 : '', answer ? new Date(Number(answer.created)).toISOString() : '']);
      }
    }
    return apiResponse(
      workbook([
        {name: 'Resumen', rows: summary},
        {name: 'Preguntas', rows: questionRows},
        {name: 'Respuestas individuales', rows: responses}
      ]),
      200,
      {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="pulso-${code}.xlsx"`
      }
    );
  }

  if (action === 'delete' && request.method === 'POST') {
    await run(env.DB, 'DELETE FROM sessions WHERE code=?', code);
    return apiResponse({deleted: true, code});
  }

  requireValue(!currentSession.ended, 'La sesión ha finalizado.', 409);

  if (action === 'questions' && request.method === 'POST') {
    const list = body.questions;
    requireValue(Array.isArray(list) && list.length > 0 && list.length <= 100, 'Añade entre 1 y 100 preguntas.');
    const count = Number((await first(env.DB, 'SELECT count(*) AS n FROM questions WHERE code=?', code)).n);
    requireValue(count + list.length <= 100, 'Máximo 100 preguntas por sesión.');
    const validated = list.map(validateQuestion);
    const statements = [];
    for (let start = 0; start < validated.length; start += 14) {
      const chunk = validated.slice(start, start + 14);
      const placeholders = chunk.map(() => '(?,?,?,?,?,?,?)').join(',');
      const params = chunk.flatMap((question, index) => [token(), code, count + start + index, question.title, JSON.stringify(question.options), question.correct, question.seconds]);
      statements.push(env.DB.prepare(`INSERT INTO questions(id,code,position,title,options,correct,seconds) VALUES ${placeholders}`).bind(...params));
    }
    await env.DB.batch(statements);
    return apiResponse(await state(env.DB, code, owner, participantId, now));
  }

  if (action === 'edit' && request.method === 'POST') {
    const question = validateQuestion(body);
    const existing = await first(env.DB, 'SELECT * FROM questions WHERE id=? AND code=?', String(body.id), code);
    requireValue(existing && existing.started === null, 'Solo se pueden editar preguntas pendientes.', 409);
    await run(env.DB, 'UPDATE questions SET title=?,options=?,correct=?,seconds=? WHERE id=?', question.title, JSON.stringify(question.options), question.correct, question.seconds, existing.id);
    return apiResponse(await state(env.DB, code, owner, participantId, now));
  }

  if (action === 'start' && request.method === 'POST') {
    requireValue(!(await first(env.DB, 'SELECT id FROM questions WHERE code=? AND started IS NOT NULL AND closed IS NULL', code)), 'Cierra la pregunta actual antes de continuar.', 409);
    const question = await first(env.DB, 'SELECT * FROM questions WHERE id=? AND code=?', String(body.id), code);
    requireValue(question && question.started === null, 'Esta pregunta ya se ha iniciado.', 409);
    try {
      await run(env.DB, 'UPDATE questions SET started=? WHERE id=?', now, question.id);
    } catch {
      throw new Problem('Cierra la pregunta actual antes de continuar.', 409);
    }
    return apiResponse(await state(env.DB, code, owner, participantId, now));
  }

  if (action === 'close' && request.method === 'POST') {
    await run(env.DB, 'UPDATE questions SET closed=? WHERE id=? AND code=? AND started IS NOT NULL AND closed IS NULL', now, String(body.id), code);
    return apiResponse(await state(env.DB, code, owner, participantId, now));
  }

  if (action === 'reveal' && request.method === 'POST') {
    const question = await first(env.DB, 'SELECT id,closed FROM questions WHERE id=? AND code=?', String(body.id), code);
    requireValue(question && question.closed !== null, 'Cierra la votación antes de mostrar los resultados.', 409);
    await run(env.DB, 'UPDATE questions SET revealed=1 WHERE id=?', question.id);
    return apiResponse(await state(env.DB, code, owner, participantId, now));
  }

  if (action === 'finish' && request.method === 'POST') {
    await env.DB.batch([env.DB.prepare('UPDATE questions SET closed=COALESCE(closed,?), revealed=1 WHERE code=? AND started IS NOT NULL').bind(now, code), env.DB.prepare('UPDATE sessions SET ended=1 WHERE code=?').bind(code)]);
    return apiResponse(await state(env.DB, code, owner, participantId, now));
  }

  throw new Problem('Acción no disponible.', 404);
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers
    });
  }
  try {
    return await handleApi(request, env);
  } catch (error) {
    if (!error.status) console.error(error);
    return apiResponse(
      {
        error: error.status ? error.message : 'No se ha podido completar la operación. Inténtalo de nuevo.'
      },
      error.status || 500
    );
  }
}

export default {
  fetch: handleRequest
};
