# 💳 MercadoPago Microservice

Microservicio construido con [NestJS](https://nestjs.com/) para gestionar pagos de reservas de canchas deportivas mediante [MercadoPago](https://www.mercadopago.cl/developers). Incluye recepción de webhooks, actualización automática del estado de reservas, envío de correos de confirmación y auditoría completa en MongoDB.

## Stack Tecnológico

| Tecnología | Uso |
|---|---|
| **NestJS** | Framework backend (Node.js + TypeScript) |
| **MercadoPago SDK v2** | Creación de preferencias de pago y consulta de pagos |
| **MongoDB + Mongoose** | Persistencia de audit logs |
| **class-validator** | Validación de DTOs |
| **uuid** | Generación de IDs únicos para ítems de pago |

## Arquitectura

```
src/
├── main.ts                         # Bootstrap + manejo de conexión MongoDB
├── app.module.ts                   # Módulo raíz (ConfigModule, MongooseModule)
├── app.controller.ts               # Health check (/)
├── app.service.ts                  # Servicio base
├── mercadopago/
│   ├── mercadopago.module.ts       # Módulo de MercadoPago
│   ├── mercadopago.controller.ts   # Endpoints: create-preference, webhook
│   ├── mercadopago.service.ts      # Lógica de negocio (pagos, webhook, reservas)
│   └── dto/
│       ├── create-mp.dto.ts        # DTO para crear preferencia de pago
│       ├── create-payment.dto.ts   # DTO de pago genérico
│       └── webhook-data.dto.ts     # DTO de notificación webhook
└── audit-log/
    ├── audit-log.module.ts         # Módulo de auditoría
    ├── audit-log.service.ts        # Servicio de logging (con dedup y tolerancia a fallos)
    ├── audit-log.entity.ts         # Schema Mongoose (colección: mp_logs)
    └── audit-log.constants.ts      # Acciones de auditoría
```

## Flujo de Pago

```mermaid
sequenceDiagram
    participant Frontend
    participant Microservice
    participant MercadoPago
    participant Backend
    participant MongoDB

    Frontend->>Microservice: POST /mercadopago/create-preference
    Microservice->>MercadoPago: Crear preferencia de pago
    MercadoPago-->>Microservice: { preferenceId, initPoint }
    Microservice-->>Frontend: URL de pago (initPoint)

    Frontend->>MercadoPago: Usuario paga

    MercadoPago->>Microservice: POST /mercadopago/webhook (notificación)
    Microservice->>MongoDB: Registrar audit log (WEBHOOK_RECEIVED)
    Microservice->>MercadoPago: Consultar estado del pago
    MercadoPago-->>Microservice: paymentInfo (status, external_reference)

    alt Pago aprobado
        Microservice->>Backend: POST /court-reserve/UpdateStateReserve/{id}
        Microservice->>MongoDB: Audit log (RESERVATION_UPDATE_OK)
    end

    Microservice->>Backend: POST /court-reserve/emailconfirmation
    Microservice->>MongoDB: Audit log (EMAIL_CONFIRMATION_OK)
```

## Endpoints

### `POST /mercadopago/create-preference`

Crea una preferencia de pago en MercadoPago para una reserva de cancha.

**Request Body:**

```json
{
  "courtId": "cancha-1",
  "date": "2026-09-01",
  "time": "18:00",
  "player1": "Juan Pérez",
  "amount": 15000,
  "idCourtReserve": "reserve-abc-123"
}
```

**Response:**

```json
{
  "preferenceId": "123456789-...",
  "initPoint": "https://www.mercadopago.cl/checkout/v1/redirect?pref_id=..."
}
```

### `POST /mercadopago/webhook`

Recibe notificaciones de pago de MercadoPago. Acepta el `paymentId` tanto en el body (`data.id`) como en query params (`data.id` o `id`).

- Si el pago es **aprobado**: actualiza la reserva y envía correo de confirmación.
- Si el pago es **rechazado/pendiente**: registra el estado y envía correo con el status.
- Responde `200 OK` después de persistir el inbox. Firmas inválidas reciben `401`; si MongoDB no está disponible se devuelve `503` para permitir reintento.

### `GET /mercadopago/health`

Expone contadores operativos en memoria para persistencia, duplicados, reintentos, fallos y efectos omitidos. No incluye payloads ni credenciales.

## Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto:

```env
# MercadoPago
MP_ACCESS_TOKEN=APP_USR-...           # Access token de MercadoPago (requerido)
MP_WEBHOOK_SECRET=...                 # Firma secreta de Webhooks (requerida)
MP_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS=300

# URLs de redirección post-pago
MP_SUCCESS_URL=https://tuapp.com/pago/exito
MP_FAILURE_URL=https://tuapp.com/pago/error
MP_PENDING_URL=https://tuapp.com/pago/pendiente

# URL donde MercadoPago envía webhooks
NOTIFICATION_URL=https://tu-microservicio.com/mercadopago/webhook

# Backend principal (para actualizar reservas y enviar correos)
BACKEND_URL=https://tu-backend.com

# MongoDB
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/db

# Persistencia y reintentos
AUDIT_LOG_RETENTION_DAYS=365
WEBHOOK_INBOX_RETENTION_DAYS=30
WEBHOOK_EFFECT_RETENTION_DAYS=365
WEBHOOK_MAX_ATTEMPTS=6
WEBHOOK_RETRY_BASE_MS=5000
WEBHOOK_RETRY_MAX_MS=900000
WEBHOOK_LOCK_TIMEOUT_MS=120000
WEBHOOK_POLL_INTERVAL_MS=5000

# Puerto (opcional, default: 3000)
PORT=3000
```

## Instalación

### Requisitos previos

- **Node.js** (ver [`.nvmrc`](.nvmrc) para la versión recomendada)
- **npm** (incluido con Node.js)
- **MongoDB** (local o Atlas)

### Configuración

```bash
# 1. Clonar el repositorio
git clone https://github.com/Asilvam/mercadopago-microservice.git
cd mercadopago-microservice

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales
```

## Ejecución

```bash
# Desarrollo (con hot-reload)
npm run start:dev

# Producción
npm run build
npm run start:prod
```

## Tests

```bash
# Tests unitarios
npm run test

# Tests e2e
npm run test:e2e

# Cobertura
npm run test:cov
```

## Persistencia de webhooks y auditoría

El endpoint valida `x-signature` antes de aceptar una notificación y guarda el webhook en MongoDB antes de responder. Un worker interno reclama los eventos mediante una operación atómica y reintenta fallos con backoff exponencial.

Se utilizan tres colecciones:

| Colección | Responsabilidad |
|---|---|
| `mp_webhook_inbox` | Recepción durable y estado `PENDING/PROCESSING/PROCESSED/FAILED` |
| `mp_webhook_effects` | Idempotencia de actualización de reserva y envío de correo |
| `mp_logs` | Auditoría append-only con correlación y retención TTL |

Los callbacks al backend incluyen `Idempotency-Key`. El backend receptor también debe respetar esa cabecera para cerrar la pequeña ventana distribuida entre completar el callback y confirmar el efecto en MongoDB.

### Acciones registradas

| Acción | Descripción |
|---|---|
| `WEBHOOK_RECEIVED` | Webhook recibido de MercadoPago |
| `WEBHOOK_PAYMENT_APPROVED` | Pago aprobado |
| `WEBHOOK_PAYMENT_PENDING` | Pago pendiente |
| `WEBHOOK_PAYMENT_REJECTED` | Pago rechazado |
| `RESERVATION_UPDATE_OK` | Reserva actualizada exitosamente |
| `RESERVATION_UPDATE_ERROR` | Error al actualizar reserva |
| `EMAIL_CONFIRMATION_OK` | Correo de confirmación enviado |
| `EMAIL_CONFIRMATION_ERROR` | Error al enviar correo |
| `WEBHOOK_ERROR` | Error general procesando webhook |

### Tolerancia a fallos

- Si MongoDB no está disponible, el webhook no se confirma como persistido y se devuelve un error temporal.
- Los errores de procesamiento se reintentan con backoff hasta `WEBHOOK_MAX_ATTEMPTS`.
- Los locks abandonados se recuperan después de `WEBHOOK_LOCK_TIMEOUT_MS`.
- Los audit logs no se deduplican: cada intento genera un evento con `eventId` propio.
- Payloads y metadata se limitan, enmascaran correos y eliminan tokens, firmas, cookies y credenciales.

## Deployment

El proyecto incluye un [`Procfile`](Procfile) para despliegue en plataformas como Heroku o Railway:

```
web: npm run start:prod
```

## Licencia

Proyecto privado — todos los derechos reservados.
