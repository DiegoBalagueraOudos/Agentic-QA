# Guía de pruebas: plantilla de QA agéntico

Esta plantilla sirve para arrancar las pruebas de un proyecto nuevo. Trae la arquitectura de pruebas (Playwright + KATA), las skills que guían el trabajo, los scripts que mantienen el estado y los reportes, y el flujo para publicar la evidencia. Aquí se explica **qué instalar, en qué orden trabajar y qué usar en cada tipo de prueba**.

> Los ejemplos con el nombre «Validate» vienen del primer proyecto que usó esta plantilla (un sistema multitenant con API cifrada, SPA en Angular y registros de logs). Sirven para ver cómo se aplica cada regla; no forman parte de la plantilla.

**Lo que esta guía no copia.** Las listas de comandos, skills y prefijos cambian. Para verlas en su versión actual:

| Qué | Dónde mirar |
|---|---|
| Comandos disponibles | `package.json`, sección `scripts` (nunca copies un comando de un documento) |
| Skills y sus reglas | `.agents/skills/REGISTRY.md` (se genera con `bun run skills:registry`) |
| Datos del proyecto (URLs, entornos, estrategia de git) | `.agents/project.yaml` |
| Estado de los casos | `bun run qa:local` (verbos de la sección 3) |

---

## Cómo se trabaja: la IA ejecuta, la persona decide

Este es un entorno de pruebas **dirigido por IA, pero con una persona al mando**. Un agente de IA ejecuta las skills: investiga el sistema, escribe los planes, genera el código de las pruebas, las corre, redacta los informes de bugs y arma los reportes. La persona fija el rumbo y decide en puntos concretos.

| La IA hace | La persona hace |
|---|---|
| Investiga, propone y escribe (planes, casos, código, informes). | **Aprueba el plan antes de que se escriba una línea de código.** |
| Ejecuta pruebas, comandos y scripts. | Decide los veredictos de los casos y qué se deja manual o diferido. |
| Prepara las decisiones con opciones y su costo (tablero `mkd` o preguntas en el chat). | Elige entre esas opciones. Un asunto de producto, de seguridad o irreversible siempre es de la persona. |
| Se detiene y pregunta si falta una credencial, un servicio o una respuesta. | Pone los secretos en el `.env`, levanta los servicios y reinicia la sesión del agente. |
| Propone el informe de un bug con su evidencia. | Da el visto bueno antes de que se cree el bug. |
| Deja los cambios en el repositorio sin confirmarlos. | **Hace los commits y los push, y publica la wiki y los reportes.** |

Reglas de convivencia:

- La IA **no inventa**: lo que no está en el código, en los mapas o en un caso, lo pregunta.
- La IA **no toca secretos** ni los repite en un chat, un archivo o un reporte.
- No se lanzan subagentes ni revisores automáticos si la persona no lo pide.
- Todo lo que la IA afirma de una corrida se comprueba contra el resultado real (el reporte, `qa:local`, el archivo), no contra lo que dijo el comando.

---

## 1. Antes de empezar

| Herramienta | Para qué |
|---|---|
| **Bun** | Ejecuta todos los scripts y las pruebas. No uses Node en su lugar. |
| **Playwright y sus navegadores** | Pruebas de pantalla y de API. Chromium con `bun run pw:install`; Edge se usa por su canal (`channel: 'msedge'`) si está instalado en el equipo; Firefox con `bunx playwright install firefox` (descarga unos 116 MB). |
| **Docker** | Levantar el sistema bajo prueba en local y sus dependencias (base de datos, caché, mensajería). |
| **Git** | Control de versiones. Los commits los hace la persona, no la IA. |
| **Un agente de IA** (Claude Code u otro compatible) | Ejecuta las skills. Se declara en `.agents/project.yaml`, clave `harnesses`. |
| **Allure** | Reporte interactivo de todas las ejecuciones (viene con las dependencias del proyecto). |
| **`playwright-cli`** | Explorar pantallas reales y capturar imágenes. Lo usan las skills. |
| **`mkd`** (skill de usuario) | Tablero de decisiones en el navegador cuando hay más de tres decisiones juntas. |

Acceso necesario: el entorno bajo prueba levantado, una cuenta de prueba por cada rol que se vaya a probar, y, si el proyecto envía correos, un buzón de pruebas (por ejemplo Mailtrap).

**Los secretos nunca se escriben en un documento ni en el chat.** Van en `.env`, se nombran por su variable (`process.env.NOMBRE`) y la IA no los lee ni los imprime.

---

## 2. Crear el proyecto y preparar la máquina

**No se trabaja sobre el repositorio de la plantilla.** La plantilla (`Agentic-QA`) es el punto de partida: cada proyecto de pruebas se crea **a partir de ella, con su propio nombre**. Si trabajas directamente en la plantilla, tus pruebas se mezclan con ella y el proyecto queda llamándose `Agentic-QA`.

### 2.1 Crear el proyecto con su nombre

Elige el nombre del proyecto antes de empezar (por ejemplo el del sistema que vas a probar). Hay tres formas de obtener la plantilla; usa **una**:

| Forma | Cómo | Cuándo |
|---|---|---|
| **Generador** (recomendada) | `bunx create-agentic-qa@latest <nombre-del-repo> --template-repo <usuario>/Agentic-QA`. Descarga la plantilla sin su historial de git, **cambia el nombre en los archivos**, inicia un repositorio nuevo con su primer commit, instala las dependencias y lanza el instalador. | Proyecto nuevo. Sin `--template-repo` descarga la plantilla original del boilerplate, no esta. Comprueba que el generador pueda leer el repositorio de la plantilla (que no sea privado sin acceso). |
| **Botón «Use this template» de GitHub** | En el repositorio de la plantilla, «Use this template» y escribe el nombre del repositorio nuevo; luego clónalo. | El repositorio de la plantilla debe estar marcado como plantilla. El nombre en los archivos se cambia después, en 2.2. |
| **Clonar o descargar el repositorio** | `git clone <url> <nombre-del-proyecto>` (o descarga el `.zip` y descomprímelo en una carpeta con ese nombre). Borra la carpeta `.git` e inicia un repositorio propio con `git init`. | Solo si no puedes usar las anteriores. El nombre en los archivos se cambia a mano, en 2.2. |

### 2.2 Dónde queda el nombre del proyecto

| Lugar | Qué es | Quién lo pone |
|---|---|---|
| Nombre del repositorio y de la carpeta | El que escribiste en 2.1 | Tú |
| `name` de `package.json` | Nombre del paquete. En la plantilla vale `agentic-qa-boilerplate` | El generador lo cambia solo. En las otras dos formas, cámbialo a mano. |
| `project.project_name` de `.agents/project.yaml` | Nombre del proyecto que leen las skills. Es la fuente de verdad. | El generador y el instalador (`bun run setup`) lo piden y lo guardan. |
| `project.project_key` de `.agents/project.yaml` | Clave del proyecto en el gestor de incidencias. Solo si usas Jira; si no, se deja vacía. | Tú, en el instalador. |

Después de crear el proyecto, abre `.agents/project.yaml` y comprueba que `project_name` ya no dice el nombre de la plantilla. Los archivos de la plantilla que hablan de «Agentic-QA» (por ejemplo el `README.md`) son la presentación de la plantilla: reescríbelos para tu proyecto cuando te toque documentarlo.

### 2.3 Preparar la máquina

Esto es la base: herramientas funcionando en tu equipo. Conocer el sistema bajo prueba y adaptar el framework **no** va aquí: son las fases 1 a 4 del flujo (sección 3), porque se hacen con skills.


1. **Instalar y comprobar:** `bun install`, luego `bun run setup`. El instalador pregunta el nombre del proyecto y sus entornos, y los guarda en `.agents/project.yaml`, que es la fuente de verdad: nada de URLs ni claves escritas a mano en las skills.
2. **Variables de entorno:** completa a mano los valores del `.env` (la plantilla es `.env.example`). Se validan con `bun run vars:check` y, para el entorno de pruebas, `bun run test:env:check`.
3. **Reiniciar la sesión del agente.** Lee el entorno al arrancar y no lo refresca después.
4. **Diagnóstico:** `bun run setup:doctor` dice qué falta. No sigas hasta que esté en verde.

Si el proyecto usa Jira y Xray, falta un paso más antes de la fase 1: sincronizar sus catálogos con `bun run jira:sync-fields`, `jira:sync-workflows` y `jira:sync-link-types`. Este flujo asume el caso **sin** gestor de pruebas.

Si la IA se encuentra sin una credencial o con un servicio caído, **se detiene y te lo dice**: no improvisa. Tras corregir el `.env`, reinicia la sesión.

---

## 3. Flujo de trabajo, fase por fase

Las fases van **en este orden**, y cada una se hace con su skill. Algunas skills comprueban que la fase anterior está hecha: por ejemplo, `/test-framework-adaptation` se niega a empezar si faltan los mapas de contexto.

El trabajo con casos usa **archivos Markdown** en `.context/QA/` y un script, `bun run qa:local`, que es la **única** forma de cambiar el estado de un caso. Nunca edites a mano el veredicto ni el estado de un caso.

| # | Fase | Skill | Qué hace | Quién decide |
|---|---|---|---|---|
| 1 | Conocer el sistema | `/project-discovery` | Recorre el repositorio del sistema bajo prueba en cuatro pasos (constitución, arquitectura, infraestructura y especificación). Produce el mapa del dominio y de la infraestructura, y `.context/project-config.md`. | La persona valida lo que descubrió. |
| 2 | Mapas de contexto | `/project-context` | Genera los mapas del negocio: `data` (entidades y ciclos de vida), `api` (qué hace cada endpoint y con qué rol), `e2e` (recorridos y funciones). Se consultan con `bun run context:map <skill> --section <id>`. El modo `test-plan` escribe el plan maestro en Jira: no aplica sin Jira. | La persona aprueba el diff antes de que se escriba. |
| 3 | Adaptar el framework | `/test-framework-adaptation` | Ajusta la arquitectura KATA, la autenticación, los esquemas de API (`bun run api:sync`), las fixtures y las variables al sistema. Primero análisis y plan; solo escribe tras tu aprobación. | La persona aprueba el plan. |
| 4 | Estrategia de git | `/git-flow-master` (Strategy Setup) | Cuatro preguntas que dejan la estrategia en `.agents/project.yaml`. Si lo saltas, la skill te lo ofrece en la primera acción de git. | La persona elige. |
| 5 | Crear los casos | `/test-case-generation-local` | Convierte la matriz de pruebas (o las historias) en un archivo por caso: `.context/QA/cases/<PREFIJO>/<ID>.md`. | La persona aprueba los casos. |
| 6 | Triage y veredicto | `/test-documentation-local` | Cada caso recibe un veredicto: `candidate` (se automatiza), `manual`, `deferred` (lo recibe otra suite) o `no_aplica`, siempre con un motivo concreto. | La persona responde fila por fila. |
| 7 | Automatizar | `/test-automation-local` | **Plan** (investiga mapas y pantallas, escribe el plan con su tabla de fuentes), **código** (un componente KATA por grupo, un ATC por caso, su spec) y **revisión** (pruebas, tipos y lint; luego se ingesta el resultado). | La persona aprueba el plan antes de cualquier código. |
| 8 | Bugs | `/bug-report-local` y `/bug-screenshot-annotation` | Si un test falla por un defecto del producto, propone el informe; con tu visto bueno lo crea y lo enlaza al caso. Todo bug de pantalla lleva **una** captura anotada. | La persona aprueba antes de crear el bug. |
| 9 | Reportes y wiki | scripts de la sección 5 | Genera la wiki y los reportes interactivos. | La persona publica. |

Después de la fase 4 el proyecto queda **adaptado**. Las fases 5 a 9 se repiten por cada lote de casos; las fases 1 a 4 solo se rehacen si el sistema cambia mucho (entonces se refrescan los mapas con `/project-context`).

Verbos de `qa:local` (confirma la lista con `bun run qa:local` sin argumentos):

| Verbo | Uso |
|---|---|
| `check` | Valida que los archivos de casos son coherentes. Debe dar 0 errores antes y después de cada cambio. |
| `next` | Cola de casos `candidate` y `pendiente` para automatizar. |
| `verdict <ID> <valor> --reason "…"` | Cambia el veredicto; el motivo es obligatorio para `manual`, `deferred` y `no_aplica`. |
| `status <ID> en_automatizacion --atc … --spec … --surface api\|e2e` | Abre el ciclo de vida del caso al empezar a automatizarlo. |
| `results --accept --scope <prefijo>` | Ingesta la última corrida; un caso solo se cierra con PASS o con FAIL que tenga un bug enlazado (queda como `EXPECTED_FAIL`). |
| `defect <caso> <bug>` | Enlaza un bug a un caso, solo después de un fallo real. |
| `bug new <caso> …` / `bug check <bug>` | Crea la carpeta del bug con su numeración y valida su informe. |
| `bug status <bug> <open\|fixed\|verified>` | Cambia el estado de un bug. |
| `index` | Regenera `estado.md` con el conteo por prefijo. |

**Regla de oro:** los tests afirman el comportamiento **correcto**, no el defectuoso. Un test que falla por un bug no se «arregla» ni se marca como esperado a mano: se reporta el bug y, tras enlazarlo, el caso queda `EXPECTED_FAIL`.

Resto de skills útiles, según el momento:

| Skill | Cuándo |
|---|---|
| `/exploratory-testing` | Explorar un flujo o módulo sin ticket. |
| `/regression-testing` | Ejecutar suites de regresión por CI y decidir GO/NO-GO. |
| `/sprint-testing`, `/sprint-conductor`, `/test-documentation`, `/test-automation` | El mismo recorrido de las fases 5 a 8 cuando el proyecto sí usa Jira y Xray. |
| `/evidence-artifact` | Convertir la evidencia en una página para compartir. |
| `/framework-development` | Cambiar el propio framework: bases KATA, fixtures, scripts, reporters. Siempre con plan y aprobación. |
| `/session-handoff` | Pasar una sesión larga a otra sin perder contexto. |
| `/pr-review-lead`, `/judgment-day` | Revisión independiente de lo que escribió la IA. |
| `/agentic-qa-onboard` | Explicar el flujo a alguien nuevo. |

---

## 4. Qué usar en cada tipo de prueba

El nombre del prefijo de cada familia de casos lo define el proyecto. La arquitectura es la misma: **componente** (clase KATA con los ATC), **fixture** (cómo llega al test) y **spec** (el archivo `.test.ts`).

| Tipo | Capa y fixture | Qué se prueba | Cuándo NO se automatiza | Ejemplo (Validate) |
|---|---|---|---|---|
| **API** (reglas de negocio, validaciones, permisos) | Clase hija de `ApiBase`; fixture `api`; specs en `tests/integration/<módulo>/` | Estados HTTP, códigos de error, cuerpos, límites, idempotencia, roles | Si exige credenciales que la API no entrega | Altas, bajas y límites de campos de tenants, sedes y terminales |
| **Pantalla** (flujos de usuario, formularios) | Clase hija de `UiBase`; fixture `ui`; specs en `tests/e2e/<módulo>/` | Campos, botones, mensajes, navegación, estados vacíos | Lo que solo juzga una persona (claridad, estética) | Inicio de sesión, contadores del dashboard, importación por CSV |
| **Seguridad** | API y pantalla; a menudo sin sesión | Cabeceras, CORS, sesión, bloqueo por intentos, no filtrar secretos | Pruebas intrusivas o fuera de alcance | Cabeceras de seguridad, intentos fallidos, cifrado en el cable |
| **Integración** (contrato entre front y back) | API y pantalla | Que la pantalla muestre lo que el contrato promete; mensajes por código de error | – | Contrato del OpenAPI, mensajes de error, servicio caído |
| **Humo** (`@critical`) | Mezcla de API y pantalla | Que la aplicación está viva: salud, los roles entran y salen | – | `GET /health`, los tres roles entran y cierran sesión |
| **No funcionales** | Según el caso | Volumen (importaciones grandes), compatibilidad de navegadores, localización | Rendimiento, accesibilidad y responsive: se difieren a su propia suite con umbrales | Importación de 1.001 filas, mismo recorrido en Chrome, Edge y Firefox, tildes y ñ |
| **Datos / integridad** | API | Que lo guardado coincide con lo enviado, relaciones, borrados | Lo que exige leer la base de datos sin que la API lo exponga | Integridad de sedes y terminales |
| **E2E de cliente de máquina** | – | Recorrido completo del dispositivo contra la API | Normalmente `manual`: exige claves del cliente que no se muestran y un simulador | Validaciones biométricas de un dispositivo |
| **UAT (aceptación)** | – | – | Siempre `manual`: la firma es del negocio. Solo se automatiza la trazabilidad si existe un documento de historias | Aceptación de cada rol |

Reglas de arquitectura que se aplican a todos:

- **Un ATC por caso** (`@atc('<id>')`, el id literal del caso). Un ATC nunca llama a otro.
- Los **helpers sin decorador** van primero en la clase; los ATC son flujos completos con nombre `verboRecursoEscenario`.
- Los **datos se generan** en cada corrida y se borran al final (`beforeAll` y `afterAll`). No se reutilizan datos reales ni de otras pruebas.
- Los **localizadores** van dentro del componente y por rol, texto visible o `formcontrolname`; no hay selectores en los archivos de casos.
- **Cuentas reales:** solo con inicio de sesión positivo (un intento fallido cuenta para su bloqueo). Los fallos se prueban con usuarios generados.
- **Todo valor tecleado que parezca un secreto** se escribe con `fillSecret` y no con `fill`. Los specs que manejan una sesión viva llevan `trace: 'off'` a nivel de archivo.
- Antes de proponer un componente, un ATC o un módulo nuevo se consulta `kata-manifest.json` (se regenera con `bun run kata:manifest`).

---

## 5. Evidencia, reportes y publicación

| Qué | Comando | Resultado |
|---|---|---|
| Reporte interactivo de todo lo ejecutado | `bun run allure:generate` | `allure-report/` |
| Reportes para compartir (Allure + Playwright de la última corrida) | `bun run reports:share --since <fecha>` | carpeta `share-reports/` |
| Wiki con casos, bugs, corridas y pendientes | `bun run qa:wiki` | carpeta `qa-wiki/` (vista previa con `bun run qa:wiki:serve`) |

Qué contiene la wiki: portada con el conteo por prefijo, una página por prefijo, los bugs con su captura anotada, las corridas, una página **Pendientes** con los casos no automatizados y su motivo, y una página de **Reportes**. Los enlaces a los reportes se guardan en `qa-wiki.local.json` (archivo local, fuera de git): `reportsUrl` para abrirlos y `downloadUrl` para el `.zip` que se descarga.

**Qué se publica y qué no**

- **Sí:** la carpeta `qa-wiki/` completa, `share-reports/`, y el código del proyecto (`tests/`, `config/`, `scripts/`, `.agents/`, `package.json`, `kata-manifest.json`).
- **Nunca:** `.env*`, `.auth/`, `allure-results/`, `test-results/`, `playwright-report/`, `reports/`. Casi todo está en `.gitignore`.
- La IA **no publica ni sube nada**: lo hace la persona.
- La carpeta `.context/QA/` (casos, bugs, corridas) está ignorada por git. Si quieres que viaje con el repo, decídelo explícitamente.

**Reporter de saneamiento.** `ScrubReporter` (primer reporter de `playwright.config.ts`) sustituye por `[redacted]` las cabeceras secretas y los `Bearer` de los errores de llamadas fallidas antes de que los lean los demás reportes. Debe seguir siendo el primero de la lista.

---

## 6. Reglas que no se rompen

Estas son las reglas comunes a todo el flujo. **Cada skill trae además sus propias reglas** en su `SKILL.md`, en la sección «Compact Rules», y también son obligatorias: la IA las sigue al ejecutar esa skill. Si una regla de una skill choca con esta guía, manda la de la skill. El resumen de las reglas de todas las skills está en `.agents/skills/REGISTRY.md`.

1. **Secretos solo por nombre.** Nunca el valor, ni en el chat, ni en un archivo, ni en un reporte.
2. **Plan antes de código,** y aprobación explícita del plan.
3. **El estado de los casos solo cambia con `qa:local`.**
4. **Sin atribución de IA en los commits.** Los commits y los push son de la persona.
5. **Lenguaje:** los informes de bugs y reportes para el equipo pueden ir en el idioma del equipo; el código y los archivos del repo, en inglés.
6. **Un cambio al framework** (bases, fixtures, scripts, reporters) va por `/framework-development`: plan, aprobación, pruebas y archivado.
7. **Cada decisión del dueño se respeta:** si dijo «no subagentes» o «deja el EXPECTED_FAIL tal cual», eso manda sobre cualquier valor por defecto.
8. **Nada de limpiezas globales de git** (`git reset --hard`, `git clean -f`, etc.): solo se descartan archivos concretos que tocaste tú.

---

## 7. Trampas conocidas

| Trampa | Qué hacer |
|---|---|
| En Windows, `bun run test` puede imprimir «todo pasó» y terminar con código 9 (un fallo de Bun al cerrar) | Juzga la corrida por las líneas del reporte y por `reports/atc_results.json`; tipos y lint sí deben salir con 0. |
| Windows no admite carpetas llamadas `con`, `prn`, `aux`, `nul`, `com1`… | No uses un prefijo de casos con ese nombre en una carpeta. El generador de la wiki ya añade `-pagina` a esas páginas. |
| Cuota del buzón de correos de prueba | Cada alta de usuario con correo o reenvío gasta un mensaje. Los specs con correo van con una etiqueta (`@mailbox`, `@resend`) para poder excluirlos de una corrida con la opción `--grep-invert` de Playwright. |
| Limitadores de intentos en el sistema bajo prueba | Los fallos de inicio de sesión comparten límite por dirección. Los specs esperan su ventana en un `finally`. |
| Tests semimanuales (dependen de que detengas un servicio) | Se activan con una variable de entorno que se lee con `.trim()` (en `cmd`, `set X=1 && …` deja un espacio al final). Sin la variable, se omiten. |
| `reports:share` se niega a escribir | El escáner busca secretos. Revisa qué patrón marca; a veces es un falso positivo (por ejemplo, la palabra `fill` dentro de `fulfill(...)` con un texto entre comillas al lado) o un adjunto de snapshot con valores tecleados. No lo saltes: corrige la fuente. |
| La limpieza de datos tarda | Borrar miles de filas de prueba una por una puede llevar minutos. Dale al `afterAll` un tiempo largo. |
| Cada corrida del reporte de Playwright reemplaza la anterior | Para publicar un reporte completo, corre todo en una sola ejecución y regenera después. |
| Los casos con bug conocido salen en rojo en el reporte de Playwright | Es lo esperado (`EXPECTED_FAIL`). Una regresión es un fallo en un caso que **no** tiene bug enlazado. |

---

## 8. Mantener esta guía

- Si cambia un comando, un script o una skill, **no la copies aquí**: apunta a su fuente (`package.json`, `.agents/skills/REGISTRY.md`).
- Si se añade un tipo de prueba nuevo, añade una fila a la tabla de la sección 4.
- Los cambios en las instrucciones permanentes del repo (`AGENTS.md` y `.agents/instructions/`) pasan por `/framework-development`, modo `instructions`.
