import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {handleRequest} from '../src/worker.mjs';
import {importQuestions, parseTable} from '../lib/import.mjs';
import {readWorkbook, workbook} from '../lib/excel.mjs';
import {qrSvg} from '../public/qr.js';

class D1StatementMock {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new D1StatementMock(this.database, this.sql, params);
  }
  async first() {
    return this.database.prepare(this.sql).get(...this.params) || null;
  }
  async all() {
    return {results: this.database.prepare(this.sql).all(...this.params)};
  }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.params);
    return {success: true, meta: {changes: Number(result.changes)}};
  }
}

class D1Mock {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(migrations)
      .filter(file => file.endsWith('.sql'))
      .sort()) {
      this.database.exec(readFileSync(new URL(file, migrations), 'utf8'));
    }
  }
  prepare(sql) {
    return new D1StatementMock(this.database, sql);
  }
  async batch(statements) {
    this.database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) {
        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(statement.sql)) results.push(await statement.all());
        else results.push(await statement.run());
      }
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.database.close();
  }
}

const question = {
  title: '¿Qué es el registro arqueológico?',
  options: ['Solo restos', 'Conjunto de residuos materiales del pasado', 'Solo estructuras'],
  correct: 1,
  seconds: 30
};

const secondQuestion = {
  title: '¿Qué proceso puede alterar la posición de los objetos?',
  options: ['Pisoteo', 'Datación', 'Dibujo'],
  correct: 0,
  seconds: 30
};

const testSalt = '0123456789abcdef0123456789abcdef';
async function passwordProof(password, salt = testSalt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const saltBytes = new Uint8Array(salt.match(/.{2}/g).map(value => Number.parseInt(value, 16)));
  const bits = await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: 210000}, key, 256);
  return [...new Uint8Array(bits)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function client(env, initialCookies = {}) {
  const cookies = {...initialCookies};
  return async (path, body, expected = 200, binary = false) => {
    const headers = new Headers();
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (Object.keys(cookies).length)
      headers.set(
        'Cookie',
        Object.entries(cookies)
          .map(([key, value]) => `${key}=${value}`)
          .join('; ')
      );
    const response = await handleRequest(
      new Request(`https://pulso.example${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      }),
      env
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
    assert.equal(response.status, expected, response.status === expected ? '' : await response.clone().text());
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
}

test('Importa tablas y genera libros XLSX válidos', () => {
  const rows = parseTable('Question:\t¿Pregunta?\nChoices:\t"1. Uno\n2. Dos"\nCorrect answers:\t2. Dos\nTime:\t20');
  assert.deepEqual(importQuestions(rows).questions[0], {
    title: '¿Pregunta?',
    options: ['Uno', 'Dos'],
    correct: 1,
    seconds: 20
  });
  const file = workbook([
    {
      name: 'Datos',
      rows: [
        ['Texto', 2],
        ['<seguro>', '=NO_ES_FORMULA()']
      ]
    }
  ]);
  assert.deepEqual(readWorkbook(file)[0][1], ['<seguro>', '=NO_ES_FORMULA()']);
});

test('Genera un QR local para el enlace de alumno', () => {
  const svg = qrSvg('https://pulso-aula.jpanera.workers.dev/alumno?codigo=123456');
  assert.match(svg, /viewBox="0 0 45 45"/);
  assert.match(svg, /Código QR para entrar como alumno/);
  assert.ok(svg.length > 3000);
});

test('Flujo completo en Worker con D1: permisos, respuesta, exportación y borrado', async () => {
  const db = new D1Mock();
  const env = {
    DB: db,
    ASSETS: {fetch: async () => new Response('asset')}
  };
  const teacher = client(env);
  const secondComputer = client(env);
  const student = client(env);
  const stranger = client(env);
  try {
    let bootstrap = await teacher('/api/bootstrap');
    assert.equal(bootstrap.authenticated, false);
    await teacher('/api/sessions', {title: 'Sin acceso'}, 401);
    const correctProof = await passwordProof('una-clave-segura');
    bootstrap = await teacher('/api/auth/register', {email: 'Profesor@UCM.es', salt: testSalt, proof: correctProof}, 201);
    assert.equal(bootstrap.authenticated, true);
    assert.equal(bootstrap.email, 'profesor@ucm.es');
    await teacher('/api/auth/register', {email: 'profesor@ucm.es', salt: testSalt, proof: await passwordProof('otra-clave-segura')}, 409);
    await secondComputer('/api/auth/login', {email: 'profesor@ucm.es', proof: await passwordProof('incorrecta-00')}, 401);
    const {salt: loginSalt} = await secondComputer('/api/auth/salt?email=profesor%40ucm.es');
    await secondComputer('/api/auth/login', {email: 'profesor@ucm.es', proof: await passwordProof('una-clave-segura', loginSalt)});
    const {code} = await teacher('/api/sessions', {title: 'Arqueología docente'}, 201);
    const endpoint = action => `/api/sessions/${code}${action ? `/${action}` : ''}`;
    assert.equal((await secondComputer('/api/bootstrap')).sessions[0].code, code);
    assert.equal((await secondComputer(endpoint())).title, 'Arqueología docente');
    let state = await teacher(endpoint('questions'), {
      questions: [question, secondQuestion]
    });
    const questionId = state.questions[0].id;
    const secondQuestionId = state.questions[1].id;
    await student(endpoint('join'), {name: 'Alumna A'});
    await stranger(endpoint(), undefined, 401);
    await stranger(endpoint('start'), {id: questionId}, 401);
    state = await stranger(endpoint('display'));
    assert.equal(state.teacher, false);
    assert.equal(state.questions.length, 0);
    state = await teacher(endpoint('display'));
    assert.equal(state.teacher, true);
    assert.equal(state.questions.length, 2);
    await teacher(endpoint('start'), {id: questionId});
    state = await student(endpoint());
    assert.equal(state.questions[0].correct, undefined);
    state = await stranger(endpoint('display'));
    assert.equal(state.questions[0].correct, undefined);
    assert.equal(state.questions[0].result, undefined);
    await student(endpoint('answer'), {question: questionId, choice: 1});
    await student(endpoint('answer'), {question: questionId, choice: 0}, 409);
    state = await stranger(endpoint('display'));
    assert.equal(state.questions[0].received, 1);
    await teacher(endpoint('close'), {id: questionId});
    state = await student(endpoint());
    assert.equal(state.questions[0].result, undefined);
    assert.equal(state.questions[0].correct, undefined);
    state = await stranger(endpoint('display'));
    assert.equal(state.questions[0].result, undefined);
    assert.equal(state.questions[0].correct, undefined);
    await stranger(endpoint('reveal'), {id: questionId}, 401);
    await teacher(endpoint('reveal'), {id: questionId});
    state = await student(endpoint());
    assert.equal(state.questions[0].result.correctPercent, 100);
    assert.equal(state.questions[0].correct, 1);
    state = await stranger(endpoint('display'));
    assert.equal(state.questions[0].correct, 1);
    assert.equal(state.questions[0].result.correctPercent, 100);
    await teacher(endpoint('start'), {id: secondQuestionId});
    db.database.prepare('UPDATE questions SET started=? WHERE id=?').run(Date.now() - 31_000, secondQuestionId);
    state = await student(endpoint());
    assert.notEqual(state.questions[1].closed, null);
    assert.equal(state.questions[1].revealed, false);
    await student(endpoint('answer'), {question: secondQuestionId, choice: 0}, 409);
    await teacher(endpoint('finish'), {});
    state = await stranger(endpoint('display'));
    assert.equal(state.ended, true);
    assert.equal(state.questions[1].revealed, true);
    const exported = await teacher(endpoint('export'), undefined, 200, true);
    const sheets = readWorkbook(exported);
    assert.equal(sheets.length, 3);
    assert.equal(sheets[0].find(row => row[0] === 'Aciertos')[1], '1');
    await stranger(endpoint('duplicate'), {}, 401);
    const copy = await teacher(endpoint('duplicate'), {}, 201);
    assert.notEqual(copy.code, code);
    state = await teacher(`/api/sessions/${copy.code}`);
    assert.equal(state.title, 'Copia de Arqueología docente');
    assert.equal(state.questions.length, 2);
    assert.equal(state.questions[0].started, null);
    assert.equal(state.questions[0].closed, null);
    assert.equal(state.participants, 0);
    assert.equal((await teacher('/api/bootstrap')).sessions.length, 2);
    await teacher(endpoint('delete'), {});
    assert.equal((await teacher('/api/bootstrap')).sessions.length, 1);
    await teacher(endpoint(), undefined, 404);
    await teacher(`/api/sessions/${copy.code}/delete`, {});
    assert.equal((await teacher('/api/bootstrap')).sessions.length, 0);
    await teacher('/api/auth/logout', {});
    assert.equal((await teacher('/api/bootstrap')).authenticated, false);
    await teacher('/api/sessions', {title: 'Después de salir'}, 401);
  } finally {
    db.close();
  }
});

test('Recupera la contraseña por correo con un enlace temporal de un solo uso', async () => {
  const db = new D1Mock();
  const sent = [];
  const env = {
    DB: db,
    ASSETS: {fetch: async () => new Response('asset')},
    RESEND_API_KEY: 're_test',
    EMAIL_FETCH: async (url, options) => {
      sent.push({url, options, body: JSON.parse(options.body)});
      return Response.json({id: 'email-test'});
    }
  };
  const originalBrowser = client(env);
  const otherComputer = client(env);
  const recoveryBrowser = client(env);
  const loginAfterReset = client(env);
  try {
    const oldProof = await passwordProof('contraseña-anterior');
    await originalBrowser('/api/auth/register', {email: 'profesor@ucm.es', salt: testSalt, proof: oldProof}, 201);
    await otherComputer('/api/auth/login', {email: 'profesor@ucm.es', proof: oldProof});

    const response = await recoveryBrowser('/api/auth/password/request', {email: 'PROFESOR@UCM.ES'});
    assert.match(response.message, /30 minutos/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.resend.com/emails');
    assert.deepEqual(sent[0].body.to, ['profesor@ucm.es']);
    assert.match(sent[0].body.subject, /contraseña de Pulso Aula/);
    const resetToken = sent[0].body.text.match(/\?reset=([a-f0-9]{64})/)[1];

    await recoveryBrowser('/api/auth/password/request', {email: 'profesor@ucm.es'});
    assert.equal(sent.length, 1, 'No debe reenviar durante el intervalo de seguridad');
    await recoveryBrowser('/api/auth/password/request', {email: 'no-existe@ucm.es'});
    assert.equal(sent.length, 1, 'La respuesta no debe revelar cuentas inexistentes');

    const newSalt = 'abcdef0123456789abcdef0123456789';
    const resetState = await recoveryBrowser('/api/auth/password/reset', {
      token: resetToken,
      salt: newSalt,
      proof: await passwordProof('contraseña-nueva-segura', newSalt)
    });
    assert.equal(resetState.authenticated, true);
    assert.equal(resetState.email, 'profesor@ucm.es');
    assert.equal((await otherComputer('/api/bootstrap')).authenticated, false, 'El cambio debe cerrar las sesiones anteriores');
    await recoveryBrowser('/api/auth/password/reset', {
      token: resetToken,
      salt: newSalt,
      proof: await passwordProof('otra-contraseña', newSalt)
    }, 400);

    await loginAfterReset('/api/auth/login', {email: 'profesor@ucm.es', proof: oldProof}, 401);
    const {salt} = await loginAfterReset('/api/auth/salt?email=profesor%40ucm.es');
    await loginAfterReset('/api/auth/login', {
      email: 'profesor@ucm.es',
      proof: await passwordProof('contraseña-nueva-segura', salt)
    });
    assert.equal((await loginAfterReset('/api/bootstrap')).authenticated, true);
  } finally {
    db.close();
  }
});

test('Vincula las encuestas antiguas a la cuenta docente al registrarse', async () => {
  const db = new D1Mock();
  const legacyOwner = 'a'.repeat(48);
  db.database.prepare('INSERT INTO sessions(code,owner,title,created) VALUES(?,?,?,?)').run('654321', legacyOwner, 'Encuesta anterior', Date.now());
  const browser = client(
    {DB: db, ASSETS: {fetch: async () => new Response('asset')}},
    {pulso_teacher: legacyOwner}
  );
  const otherComputer = client({DB: db, ASSETS: {fetch: async () => new Response('asset')}});
  try {
    let state = await browser('/api/bootstrap');
    assert.equal(state.authenticated, false);
    assert.equal(state.legacySessions, true);
    const proof = await passwordProof('contraseña-segura');
    state = await browser('/api/auth/register', {email: 'docente@ucm.es', salt: testSalt, proof}, 201);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].code, '654321');
    const {salt} = await otherComputer('/api/auth/salt?email=docente%40ucm.es');
    await otherComputer('/api/auth/login', {email: 'docente@ucm.es', proof: await passwordProof('contraseña-segura', salt)});
    state = await otherComputer('/api/bootstrap');
    assert.equal(state.sessions[0].title, 'Encuesta anterior');
  } finally {
    db.close();
  }
});

test('La cabecera del alumno no ofrece acceso a Profesor', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const studentHeader = source.slice(source.indexOf('if (role === "student")'), source.indexOf('return `<header><a class="brand"', source.indexOf('if (role === "student")')));
  assert.doesNotMatch(studentHeader, /data-action="teacher"|>Profesor</);
  assert.match(studentHeader, /Vista del alumno/);
  assert.match(source, /He olvidado mi contraseña/);
  assert.match(source, /reset-password-form/);
});

test('Sirve los recursos estáticos mediante el binding ASSETS', async () => {
  let requested;
  const response = await handleRequest(new Request('https://pulso.example/alumno'), {
    ASSETS: {
      fetch: async request => {
        requested = request.url;
        return new Response('inicio');
      }
    }
  });
  assert.equal(await response.text(), 'inicio');
  assert.equal(requested, 'https://pulso.example/alumno');
});
