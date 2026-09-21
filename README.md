# Pulso Aula · versión Cloudflare

Aplicación de encuestas para clase adaptada a **Cloudflare Workers + D1**. Conserva las vistas de profesor y alumno, la importación de Excel, los temporizadores, los resultados, la exportación `.xlsx`, el borrado y la duplicación de sesiones. También incluye un QR de acceso y una pantalla de proyección de solo lectura.

Esta versión no utiliza un servidor Node permanente, Docker ni un archivo SQLite local. El Worker ejecuta la API y **Cloudflare D1** conserva sesiones, preguntas, participantes y respuestas.

## Estructura que debe estar en GitHub

Sube el contenido de esta carpeta a la raíz del repositorio:

- `src/worker.mjs`: API del Worker.
- `migrations/0001_initial.sql`: tablas de D1.
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

En cada sesión, el profesor dispone de un botón **Pantalla de proyección**. Esta vista muestra un QR grande, el código, la pregunta, las opciones, la cuenta atrás y el número de respuestas. No revela la solución mientras la pregunta está abierta; al cerrarla presenta los resultados y señala la respuesta correcta.

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
- La identidad del profesor se conserva mediante una cookie segura. Usa el mismo navegador y no borres sus cookies si quieres volver a gestionar las sesiones.
- **Duplicar** crea una sesión nueva con las mismas preguntas, opciones, soluciones y tiempos. No copia participantes, respuestas, resultados ni el estado de las preguntas.
- Durante una pregunta la interfaz consulta cambios cada 2 segundos; mientras espera, cada 5 segundos. Esta configuración está pensada para una clase ordinaria y reduce el consumo del plan gratuito.
- El QR se genera íntegramente en el navegador; no envía el enlace a servicios externos.
- La respuesta se valida en el servidor y no se acepta fuera de plazo.
- La respuesta correcta y los resultados permanecen ocultos para el alumno hasta cerrar la pregunta.
- Cada sesión admite hasta 100 preguntas y cada pregunta entre 2 y 8 opciones.
- La importación admite `.xlsx`, texto copiado desde Excel y Markdown. El archivo Excel puede ocupar hasta 5 MB.

## Pruebas automatizadas

```sh
npm test
```

Las pruebas cubren importación y creación de Excel, permisos de profesor/alumno, participación, respuesta única, ocultación y publicación de resultados, exportación, borrado y acceso a los recursos estáticos.

## Copias de seguridad

Antes de borrar una sesión importante, descarga su Excel desde la vista del profesor. Para una copia completa de D1 puedes utilizar las funciones de exportación o recuperación disponibles en el panel de Cloudflare.
