# pickleball-relay

Rooms by code for Pickleball '94's games (and Sundown Run's): a tiny WebSocket relay on Azure
Container Apps. Both sides dial out to it and meet in a room by a
four-letter code, so nobody forwards ports, and a browser can play too.
The plan and its reasons are in the port kit's `design/RELAY.md`.

It knows nothing of pickleball or racing. It pairs connections in rooms and passes
their messages on. Nothing is stored, there are no accounts, and the logs
keep counts, never payloads.

## The protocol (v1)

```
wss://<relay>/v1/host?game=pb94-port&ver=0.43.0  -> {"op":"room","code":"BXKM"}
wss://<relay>/v1/join?game=pb94-port&code=BXKM   -> {"op":"welcome","you":0,"ver":"0.43.0"}
the host then gets {"op":"joined","guest":0,"ver":...} and {"op":"left","guest":0}
GET https://<relay>/healthz                      -> 200 "ok"
GET https://<relay>/c/BXKM                       -> the page a pb94-vr-coach host sent
GET https://<relay>/                             -> a box for the room code, then /c/<room>
```

- **Binary frames are the games' messages**, in order, nothing lost.
  - The host's carry a one-byte header both ways: the guest's number, or
    255 (host to guests) for all of them.
  - Guests send and receive bare payloads; the relay adds and strips the
    header.
- **Text frames are control messages**, JSON with an `op`.
  - `error` comes with a reason, then the relay closes the connection:
    NO SUCH GAME, NO SUCH ROOM, ROOM FULL, SERVER FULL, TOO MANY ROOMS,
    TOO FAST, HOST LEFT, IDLE, TIME UP.
  - A `pb94-vr-coach` host may send `{"op":"page","html":...}`; the relay
    then serves it at `/c/<code>` while the room is open.
- **Codes** are four consonants from `BCDFGHJKLMNPQRSTVWXZ` (no I or O to
  misread, no vowels so no words), 160,000 of them, and each game has its
  own: a VR code never finds a port room.

| Game | Guests |
|------|--------|
| `pb94-port` (the port's ONLINE) | 1 |
| `pb94-vr-coach` (coach phones) | 8 |
| `pb94-vr` (VR online, later) | 3 |
| `sundown-run` (the arcade racer's online races) | 3 |

**Limits:** 1 MiB a message, 200 messages a second per connection, 10
rooms a minute per address, 20 wrong rooms a minute per address (pages
and joins; past it, `TOO MANY TRIES` for a minute, since a VR coach room
needs nothing else), 500 connections. A room ends when its host
leaves, after 10 minutes with no messages, or after 4 hours. A ping every
15 s keeps connections alive through Azure's ingress.

## Running it

```sh
npm ci
npm test          # two fake games over a local relay
npm start         # on :8080 (PORT to change it)
```

## On Azure

- `infra/main.bicep`: a Container Apps environment and the app, on the
  consumption plan, 0 to 1 replicas of 0.25 vCPU and 0.5 GiB, no log
  workspace. The monthly free grant covers about 200 hours of play.
- `infra/budget.bicep`: $5 a month on the resource group, with email alerts.
- `infra/setup.sh`: the one-time setup (resource group, budget, and the
  app registration GitHub signs in as through OIDC, so no Azure secret is
  stored anywhere).
- `.github/workflows/deploy.yml`: tests on every push. On main it also
  builds the image to ghcr.io and deploys it, then checks `/healthz`.
  The image must be public, since Azure pulls it without signing in.
