import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRequest } from '../src/worker.mjs';
import { importQuestions, parseTable } from '../lib/import.mjs';
import { readWorkbook, workbook } from '../lib/excel.mjs';

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
    this.database.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
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

function client(env) {
  const cookies = {};
  return async (path, body, expected = 200, binary = false) => {
    const headers = new Headers();
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (Object.keys(cookies).length) headers.set('Cookie', Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await handleRequest(new Request(`https://pulso.example${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }), env);
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
  assert.deepEqual(importQuestions(rows).questions[0], {title: '¿Pregunta?', options: ['Uno', 'Dos'], correct: 1, seconds: 20});
  const file = workbook([{name: 'Datos', rows: [['Texto', 2], ['<seguro>', '=NO_ES_FORMULA()']]}]);
  assert.deepEqual(readWorkbook(file)[0][1], ['<seguro>', '=NO_ES_FORMULA()']);
});

test('Flujo completo en Worker con D1: permisos, respuesta, exportación y borrado', async () => {
  const db = new D1Mock();
  const env = {
    DB: db,
    ASSETS: {fetch: async () => new Response('asset')}
  };
  const teacher = client(env);
  const student = client(env);
  const stranger = client(env);
  try {
    await teacher('/api/bootstrap');
    const {code} = await teacher('/api/sessions', {title: 'Arqueología docente'}, 201);
    const endpoint = action => `/api/sessions/${code}${action ? `/${action}` : ''}`;
    let state = await teacher(endpoint('questions'), {questions: [question]});
    const questionId = state.questions[0].id;
    await student(endpoint('join'), {name: 'Alumna A'});
    await stranger(endpoint(), undefined, 401);
    await stranger(endpoint('start'), {id: questionId}, 403);
    await teacher(endpoint('start'), {id: questionId});
    state = await student(endpoint());
    assert.equal(state.questions[0].correct, undefined);
    await student(endpoint('answer'), {question: questionId, choice: 1});
    await student(endpoint('answer'), {question: questionId, choice: 0}, 409);
    await teacher(endpoint('close'), {id: questionId});
    state = await student(endpoint());
    assert.equal(state.questions[0].result.correctPercent, 100);
    assert.equal(state.questions[0].correct, 1);
    const exported = await teacher(endpoint('export'), undefined, 200, true);
    const sheets = readWorkbook(exported);
    assert.equal(sheets.length, 3);
    assert.equal(sheets[0].find(row => row[0] === 'Aciertos')[1], '1');
    await teacher(endpoint('delete'), {});
    assert.equal((await teacher('/api/bootstrap')).sessions.length, 0);
    await teacher(endpoint(), undefined, 404);
  } finally {
    db.close();
  }
});

test('Sirve los recursos estáticos mediante el binding ASSETS', async () => {
  let requested;
  const response = await handleRequest(new Request('https://pulso.example/alumno'), {
    ASSETS: {fetch: async request => { requested = request.url; return new Response('inicio'); }}
  });
  assert.equal(await response.text(), 'inicio');
  assert.equal(requested, 'https://pulso.example/alumno');
});
