# Pulso Aula · versión Cloudflare

Aplicación de encuestas para clase adaptada a **Cloudflare Workers + D1**. Conserva las vistas de profesor y alumno, la importación de Excel, los temporizadores, los resultados, la exportación `.xlsx`, el borrado y la duplicación de sesiones. También incluye un QR de acceso, una pantalla de proyección controlable y una cuenta docente accesible desde cualquier ordenador.

Esta versión no utiliza un servidor Node permanente, Docker ni un archivo SQLite local. El Worker ejecuta la API y **Cloudflare D1** conserva sesiones, preguntas, participantes y respuestas.

## Estructura que debe estar en GitHub

Sube el contenido de esta carpeta a la raíz del repositorio:

- `src/worker.mjs`: API del Worker.
- `migrations/`: tablas y actualizaciones de D1.
- `public/`: interfaz web.
- `lib/`: lectura y creación de Excel.
- `wrangler.jsonc`: configuración de Cloudflare.
- `package.json`: comandos de desarrollo y despliegue.
- `ejemplo-arqueologia.xlsx`: ejemplo de importación.

Los antiguos `server.mjs`, `Dockerfile`, `compose.yaml` e `iniciar.cmd` ya no son necesarios en Cloudflare.

## Primera publicación

Necesitas Node.js 20 o posterior y una cuenta gratuita de Cloudflare.

1. Descarga o clona el repositorio y abre una terminal dentro de su carpeta.
2. Instala la herramienta de Cloudflare:

   ```sh
   npm install
   ```

3. Inicia sesión:

   ```sh
   npx wrangler login
   ```

4. Crea la base de datos:

   ```sh
   npx wrangler d1 create pulso-aula
   ```

5. El comando mostrará un `database_id`. Copia ese identificador y sustituye en `wrangler.jsonc` este valor:

   ```text
   00000000-0000-0000-0000-000000000000
   ```

6. Publica la aplicación y crea sus tablas:

   ```sh
   npm run deploy
   ```

Al terminar aparecerá una dirección similar a:

```text
https://pulso-aula.NOMBRE-DE-TU-CUENTA.workers.dev
```

El profesor entra en la dirección principal. Los alumnos utilizan:

```text
https://pulso-aula.NOMBRE-DE-TU-CUENTA.workers.dev/alumno
```

La ruta del alumno no muestra ninguna pestaña ni enlace hacia la zona de profesor.

## Cuenta del profesor

La primera vez, abre la dirección principal desde el navegador que utilizabas para gestionar Pulso Aula y selecciona **Crear cuenta**. Introduce tu correo y una contraseña de al menos 10 caracteres. Las encuestas que pertenecían a la cookie de ese navegador se vinculan automáticamente a la nueva cuenta.

A partir de entonces puedes iniciar sesión con el mismo correo y contraseña desde cualquier ordenador. La contraseña se deriva en el navegador con PBKDF2-SHA-256 y una sal individual; el servidor recibe una prueba derivada y conserva únicamente su verificador. Las sesiones de acceso duran 90 días y pueden cerrarse desde la cabecera.

La pantalla de acceso incluye **He olvidado mi contraseña**. El enlace de recuperación se envía al correo registrado, caduca a los 30 minutos y solo puede utilizarse una vez. Al establecer una contraseña nueva se cierran las sesiones que estuvieran abiertas en otros navegadores.

## Configurar la recuperación por correo

Pulso Aula utiliza la API de Resend, que dispone de un plan gratuito suficiente para los correos de recuperación habituales:

1. Crea una cuenta en `https://resend.com` con el mismo correo que utilizarás en Pulso Aula.
2. En Resend, crea una API key.
3. En Cloudflare entra en **Workers & Pages → pulso-aula → Settings → Variables and Secrets**.
4. Añade un valor de tipo **Secret** con:

   - Nombre: `RESEND_API_KEY`
   - Valor: la API key creada en Resend, que empieza por `re_`.

5. Guarda y despliega los cambios.

Sin configurar un dominio propio, Resend utiliza el remitente de pruebas `onboarding@resend.dev` y solo permite enviar al correo con el que se creó la cuenta de Resend. Esto basta si Pulso Aula tiene una única cuenta docente con ese mismo correo.

Para enviar a otras cuentas, verifica un dominio propio en Resend y añade en Cloudflare una variable de texto llamada `MAIL_FROM`, por ejemplo:

```text
Pulso Aula <acceso@tudominio.es>
```

La clave de Resend nunca debe escribirse en GitHub ni en `wrangler.jsonc`.

En cada sesión, el profesor dispone de un botón **Pantalla de proyección**. Esta vista muestra un QR grande, el código, la pregunta, las opciones, la cuenta atrás y el número de respuestas. Cuando se abre desde el navegador autorizado del profesor también permite iniciar preguntas, cerrar la votación, mostrar los resultados y finalizar la sesión. La misma URL abierta en otro navegador continúa siendo una pantalla pública de solo lectura.

## Probar antes de publicar

Después de crear la base en Cloudflare y colocar su identificador en `wrangler.jsonc`:

```sh
npm run db:local
npm run dev
```

Wrangler mostrará una dirección local, normalmente `http://localhost:8787`.

## Publicaciones posteriores desde GitHub

Puedes conectar el repositorio desde **Cloudflare Workers & Pages → Create → Import a repository**. Utiliza:

- Comando de despliegue: `npm run deploy`
- Rama de producción: la rama principal del repositorio, normalmente `main`

El comando aplica primero las migraciones pendientes de D1 y después publica el Worker. No borra los datos existentes.

## Funcionamiento y límites

- Las sesiones y respuestas se guardan permanentemente en D1.
- La identidad del profesor se gestiona mediante una cuenta con correo y contraseña y una cookie de sesión segura. La cuenta permite recuperar las encuestas desde distintos ordenadores.
- Al crear la cuenta desde el navegador utilizado en versiones anteriores, las encuestas existentes se migran automáticamente y no se borran.
- Tras cinco intentos de acceso fallidos, el correo queda bloqueado durante 15 minutos para dificultar ataques de fuerza bruta.
- La recuperación no revela si un correo está registrado. Los enlaces se guardan cifrados mediante SHA-256, caducan en 30 minutos y quedan invalidados después de utilizarlos.
- **Duplicar** crea una sesión nueva con las mismas preguntas, opciones, soluciones y tiempos. No copia participantes, respuestas, resultados ni el estado de las preguntas.
- Durante una pregunta la interfaz consulta cambios cada 2 segundos; mientras espera, cada 5 segundos. Esta configuración está pensada para una clase ordinaria y reduce el consumo del plan gratuito.
- El QR se genera íntegramente en el navegador; no envía el enlace a servicios externos.
- La respuesta se valida en el servidor y no se acepta fuera de plazo.
- La respuesta correcta y los resultados permanecen ocultos para el alumno hasta que el profesor los muestra. Cerrar la votación y revelar los resultados son acciones independientes.
- Cada sesión admite hasta 100 preguntas y cada pregunta entre 2 y 8 opciones.
- La importación admite `.xlsx`, texto copiado desde Excel y Markdown. El archivo Excel puede ocupar hasta 5 MB.

## Pruebas automatizadas

```sh
npm test
```

Las pruebas cubren registro, login desde otro ordenador, recuperación de contraseña por correo, caducidad lógica y uso único del enlace, cierre de sesiones anteriores, migración de encuestas antiguas, cierre de sesión, permisos de profesor/alumno, importación y creación de Excel, participación, respuesta única, ocultación y publicación de resultados, exportación, borrado y acceso a los recursos estáticos.

## Copias de seguridad

Antes de borrar una sesión importante, descarga su Excel desde la vista del profesor. Para una copia completa de D1 puedes utilizar las funciones de exportación o recuperación disponibles en el panel de Cloudflare.
