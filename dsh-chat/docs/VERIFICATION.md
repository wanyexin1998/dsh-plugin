# 历史审计档案 — 独立对抗式验证

> **这是历史记录，不是当前状态的说明。**
>
> 这些报告由两位独立验证者在开发中期写成，针对的是当时仍命名为
> `dsh-deepseek-chat-bridge` 的修订版。此后插件改名为 **dsh-chat**，并经历了
> 若干实质变更：切换条改为悬浮、账号读out 与 `/api/account` 路由被移除、cookie
> 改为 `SameSite=None; Secure`、iframe 导航不再 302。因此文中提到的路由名、
> 配置键、测试文件名与部分结论**已不适用于当前版本**。
>
> 保留它们的价值在于：记录当时发现的真实缺陷、验证手法与"无法验证"的边界。
> 当前版本的验收标准与实测结果见 [../README.md](../README.md) 第 7 节。

---

# Independent adversarial verification — `dsh-deepseek-chat-bridge`

- Verifier: `verifier` teammate (did not write any product code; reported only)
- Shared task: `task-4`
- Window: 2026-10-10 15:57 → 16:09 (+08:00)
- Verdict: **all 7 acceptance criteria PASS on revision REV2** (nuances noted per criterion).
  Four real product defects were found outside the criteria, the most user-visible being
  that the framed DeepSeek Chat app boots **signed out** and that two CORS-mode
  subresources (web fonts, opus wasm) are blocked by the CDN.
- Safety: the live desktop app (PID 26192 tree: 28104/28136/28288/4104, port 19387) was
  never stopped, restarted or attached to; nothing under
  `C:\Users\wanyexin\.dsh\profiles\desktop` or `...\profiles\node_modules` was written.
  The only profile touched was `chatbridge-test` (read) and its node_modules junction.

---

## 0. Revision binding — the artifact changed while it was being verified

The product was **not frozen** when verification began. Hashes were taken at 15:57:43
(REV1) and again after a clean restart at 16:06 (REV2); two files differ and one new test
file appeared:

| file | REV1 (15:57:43) | REV2 (16:06, final) | mtime |
| --- | --- | --- | --- |
| `lib/index.js` | F5097511…5E606 | F5097511…5E606 | 15:46:57 |
| `lib/bridge-proxy.js` | 5004A631…61E1 | **5A52926B…985D** | **15:57:58** |
| `lib/account.js` | 5CD10781…4F2C | 5CD10781…4F2C | 15:34:00 |
| `lib/config.js` | 9BE1B093…880D | 9BE1B093…880D | 15:42:09 |
| `lib/shared.js` | 0E153F2F…3D3E | 0E153F2F…3D3E | 15:34:25 |
| `lib/client.js` | E843590E…114D | **491F3296…CE88** | **16:03:49** |
| `package.json` | DDA8638E…002FB | DDA8638E…02FB | 15:33:23 |
| `cordis.patch.yml` | 6B249DA3…AC3F | 6B249DA3…AC3F | 15:34:50 |
| `dsh.plugin.json` | 1B4CD834…8DC6 | 1B4CD834…8DC6 | 15:33:23 |
| `tests/verify-ui.mjs` | BC3AC089…7E4A | BC3AC089…7E4A | 15:57:19 |
| `tests/unit-host.mjs` | *(did not exist)* | 1E90C023…3859 | 15:58:07 |

Consequences and how they were handled:

- The Lead's already-running test instance (PID 41988, booted 15:55:01) predated the
  15:57:58 write to `bridge-proxy.js` and served a **stale bundle**. It was stopped
  (listener on 19389 only) and the profile rebooted, so REV1/REV2 evidence comes from a
  process that loaded the file from disk at 15:58:50.
- `client.js` was then rewritten at **16:03:49**, i.e. *during* the browser runs. Every
  proxy/module/config probe and the whole browser pass were therefore **re-executed on
  the final revision** (boot 16:06:02, PID 45368). REV1 and REV2 outputs are identical
  on every criterion, so the churn did not change the verdict — but no earlier partial
  result was reused as final evidence.
- Final hashes were re-read at 16:08:49 and match the 16:06 freeze: no further churn.
- Process note: the task said the Lead would not touch the evidence loop. Three writes
  landed inside it (`bridge-proxy.js` 15:57:58, `unit-host.mjs` 15:58:07,
  `client.js` 16:03:49). Any verdict must name its revision; this one is **REV2**.

Test instance: `chatbridge-test` profile on **port 19389** only (bridge proxy on an
OS-assigned 34264); stopped at the end by the documented
`Get-NetTCPConnection -State Listen -LocalPort 19389 | Stop-Process -Force` recipe.

---

## 1. Acceptance criteria

Boot used the documented command (via `Start-Process` with output redirected so the
printed token could be read):

```powershell
$env:BROWSER='cmd /c exit 0'
Start-Process -FilePath 'E:\deepseek-harness\resources\runtime\cli\bin\dsh.cmd' `
  -ArgumentList '--profile','chatbridge-test','--port','19389' `
  -RedirectStandardOutput '...\.tmp-verify\boot-verifier2.log' -RedirectStandardError '...\.tmp-verify\boot-verifier2.err.log' -WindowStyle Hidden
```

```
dsh web: http://127.0.0.1:19389/?token=2Bov2L-6mPG-j8gn8aec0vAQrixAK_CDaOM2ueQqeoU
```

### C1. Capsule in the frame-wide overlay, labels 对话 + CHAT, no bundle console errors — **PASS**

Command (product harness, which is also the criterion's own instrument):

```powershell
node E:\wyx_code\dsh-deepseek-chat-bridge\tests\verify-ui.mjs http://127.0.0.1:19389 <token> .tmp-verify\rev2-verify-ui.png
```

Raw (REV2):

```
== capsule rendered
   [{"label":"对话","pressed":"true"},{"label":"CHAT","pressed":"false"}]
== overlay hidden before switching
   hidden
== console errors
   none
EXITCODE=0
```

Independently reproduced with a second, self-written CDP harness
(`.tmp-verify\cdp-verify.mjs`, does not reuse `verify-ui.mjs`):

```
== 1. capsule buttons
[{"label":"对话","pressed":"true"},{"label":"CHAT","pressed":"false"}]
== 2. capsule lives in the frame-wide overlay layer
{"capsuleFound":true,"position":"fixed","zIndex":"502","pointerEvents":"auto","viewport":[1250,771]}
== 18. console errors (all sessions)
none
```

`console errors` covers `Runtime.consoleAPICalled(type=error)` and `Runtime.exceptionThrown`
in the page session *and* in every auto-attached child (iframe) session — **0 from the
bundle in both harnesses and in a third run after `client.js` changed**. The screenshot
`.tmp-verify\rev2-cdp.png` shows the capsule top-centre with 对话 / CHAT / 👤 above the
takeover banner `DeepSeek Chat 网页版  191******25 ¥9.0x`.

Caveat (see defect D2): the *browser's* error log is not clean — 3 CORS errors appear
while the panel is open. They are emitted by the network stack, not by the bundle's code,
so this criterion passes as worded; the stricter reading does not.

### C2. CHAT mounts an iframe whose document is 200 text/html and whose `fe-static.deepseek.com` subresources are 200 — **PASS**

Raw (REV2, product harness):

```
== chat iframe mounted
   http://127.0.0.1:34264/?__bridge_session=988e21eb…7bb41
== framed document responses
   [{"url":"http://127.0.0.1:34264/?__bridge_session=988e21eb…7bb41","status":200,"type":"Document","mimeType":"text/html"}]
== framed subresources from fe-static
   14
== framed subresource statuses
   ["200 main.1d00a4d01e.css","200 default-vendors.df13be609e.js","200 main.1054336dc6.js","200 katex.effce08cb3.css","katex.ef343f2527.js","87321.87453ce690.js"]
```

Independent harness, cold Edge profile (no cache), **full** status list rather than the
first six:

```
== 7. ALL fe-static.deepseek.com subresources
{"count":6,"nonOk":[],"statuses":["200 main.1d00a4d01e.css","200 default-vendors.df13be609e.js","200 main.1054336dc6.js","200 katex.effce08cb3.css","200 katex.ef343f2527.js","200 87321.87453ce690.js"]}
== 9. requests to the bridge origin
{"count":7,"nonOk":[]}
```

I also read the framed document's **own DOM** through its CDP execution context, which
proves the real app executed rather than merely downloading assets:

```
== 5. framed document DOM (read inside the frame)
{"title":"DeepSeek - 探索未至之境","href":"http://127.0.0.1:34264/sign_in","readyState":"complete",
 "elementCount":126,"hasAppRoot":true,"localStorageKeys":[…31 keys…],
 "bodyTextSample":"+86 发送验证码 注册登录即代表已阅读并同意我们的 用户协议 与 隐私政策…微信扫码登录"}
```

Evidence gap in the product harness: its `first framed document response` step printed
`none recorded` in **both** REV1 and REV2 — the first iframe navigation's Document
response is not in its `responses` array; only the later in-panel-refresh navigation is.
The criterion is still satisfied by that later 200/Document entry plus my independent
cold-cache capture. Worth fixing in the harness (see D6).

### C3. Switching back to 对话 hides the takeover, KEEPS the iframe mounted, no `[inert]` on shell columns — **PASS**

Product harness (REV2):

```
== after switching back
   {"overlayPresent":true,"overlayVisible":false,"inertChildren":0,"frameStillMounted":1}
```

Independent harness — stronger, because it also proves the frame node was never remounted
and never re-navigated:

```
== 14. after switching back to 对话
{"overlayVisibility":"hidden","overlayPointerEvents":"none","globalInertCount":0,
 "rootChildInertCount":0,"frameCount":1,"sameFrameNode":true,
 "frameSrc":"http://127.0.0.1:34264/?__bridge_session=988e21eb…7bb41"}
== 15. switch back to CHAT keeps the same frame node
{"sameFrameNode":true,"frameCount":1,"inertCount":1}
== 16. no document reload across the round trip
{"documentsBefore":3,"documentsAfter":3}
```

### C4. While open: ≥1 large shell subtree `[inert]`; capsule not inside `[inert]` and hit-testable — **PASS**

Product harness (REV2):

```
== inert subtrees behind the takeover
   1
== takeover subtrees are the shell columns
   [{"width":970,"height":771,"tag":"DIV"}]
== capsule is not inert and is clickable
   {"insideInert":false,"pointerEvents":"auto","topElementIsInsideCapsule":true}
```

Independent harness, hit-testing every capsule control and the shell underneath:

```
== 10. inert subtrees while takeover is open
[{"tag":"DIV","w":970,"h":771,"label":null}]
== 11. capsule hit-testing + inert ancestry
{"insideInert":false,"hits":[{"label":"对话","topElement":"对话","insideCapsule":true},
 {"label":"CHAT","topElement":"CHAT","insideCapsule":true},{"label":"👤","topElement":"👤","insideCapsule":true}]}
== 12. shell is NOT clickable through the takeover
{"topTag":"IFRAME","insideOverlay":true}
```

970×771 of a 1250×771 viewport = 77.6% of the shell area is inert; the overlay itself is
covered by the framed app, so nothing of the DSH conversation is clickable behind it.

### C5. Account route returns the real desktop account; independent cross-check; no token echo — **PASS**

Plugin route (REV2, `& .tmp-verify\extras.ps1 <token>`):

```
plugin route: {"signedIn":true,"id":"1c68bb90-d359-4459-93ed-e05b9552f9dc","email":"wan******998@outlook.com",
"mobile":"191******25","areaCode":"+86","name":"万叶欣","avatar":"https://static.deepseek.com/user-avatar/_O5fcQni7xDJw-0z3CKI4sZk",
"currency":"CNY","balance":"9.1647650600000000","bonus":"0","platformOrigin":"https://platform.deepseek.com"}
```

Independent HTTPS call, token read from `C:\Users\wanyexin\.dsh\.credentials.yaml`
(64 chars, masked `iMmY94…IJUA`) and sent as `x-dsh-auth-token` (PowerShell `Invoke-WebRequest`,
not the plugin's code):

```
direct platform: id=1c68bb90-d359-4459-93ed-e05b9552f9dc name=万叶欣 mobile=191******25
                 email=wan******998@outlook.com currency=CNY balance=9.1647650600000000 bonus=0
field-by-field match: id=True name=True mobile=True balance=True currency=True bonus=True
```

`balance` is live (the account is being used while we test: 9.5554 → 9.3295 → 9.1648 →
9.0386 across the session); the paired check above matched exactly at the same instant.

Token containment:

```
### lib/ source files containing the grant token literal
none (0 matches in lib/)
### route bodies echoing the grant token?
api/session : HTTP 200 containsGrantToken=False
api/account : HTTP 200 containsGrantToken=False
probe       : HTTP 200 containsGrantToken=False
### logs containing the grant token
boot-verifier.log: containsGrantToken=False   boot-verifier.err.log: containsGrantToken=False
### session token vs grant token
sessionToken len=64; equalsGrantToken=False
```

Note the sharpened version of this test: the upstream body **does** carry the same grant
token (`biz_data.token` = `iMmY94…IJUA`), so the mapper in `lib/account.js` is the only
thing standing between it and the route. It drops it: the route payload above contains
`id/email/mobile/areaCode/name/avatar/currency/balance/bonus` and nothing else secret.
(`account.js` also sends it only to the configured `platformOrigin`, with `redirect:'error'`.)

### C6. Unit-test `lib/config.js` directly with node — **PASS**

Command: `node .tmp-verify\config-unit.mjs` (27 cases; the module is imported from disk,
nothing is stubbed). Valid inputs:

```
resolveBridgeConfig(undefined) => {"target":"https://chat.deepseek.com","port":0,"accountTimeoutMs":15000,"platformOrigin":"https://platform.deepseek.com","seed":{}}
resolveBridgeConfig({})        => … same defaults …
valid explicit config          => {"target":"https://chat.deepseek.com","port":34567,"accountTimeoutMs":5000,"platformOrigin":"https://platform.deepseek.com","credentialsPath":"C:\\x\\y.yaml","seed":{"k":"v"}}
credentialsPath omitted        => undefined        port 0 accepted        port 65535 accepted
accountTimeoutMs 120000 accepted                   empty seed object -> {}
```

Every required rejection **threw** (raw messages):

```
non-object: string "nope"            => Error: …config must be a mapping
non-object: number 42                => Error: …config must be a mapping
non-object: array []                 => Error: …config must be a mapping
target no scheme "chat.deepseek.com" => Error: …config.target is not a URL: chat.deepseek.com
target with path                     => Error: …config.target must be a bare origin
target with query                    => Error: …config.target must be a bare origin
target non-http scheme               => Error: …config.target must be http or https
port -1                              => Error: …config.port must be an integer between 0 and 65535
port 70000                           => Error: …config.port must be an integer between 0 and 65535
port 1.5                             => Error: …config.port must be an integer between 0 and 65535
accountTimeoutMs 0                   => Error: …config.accountTimeoutMs must be an integer between 1 and 120000
credentialsPath ""                   => Error: …config.credentialsPath must be a non-empty string
credentialsPath "   "                => Error: …config.credentialsPath must be a non-empty string
seed non-string value {k:1}          => Error: …config.seed.k must be a string
seed array ['a']                     => Error: …config.seed must be a mapping of storage key to string
summary: cases=27 | threw=18 | did not throw=9
```

The Lead's own `tests/unit-host.mjs` (added mid-run) also covers this and passed 32/32,
including `config rejects …` for all ten cases.

### C7. Adversarial proxy probes — **PASS, with two honest nuances**

All of the following are PowerShell/raw-`HttpClient` probes against the live bridge
(`.tmp-verify\probe-proxy.ps1`, `.tmp-verify\probe-proxy2.ps1`) plus a module-level probe
against a **controlled HTTPS echo upstream** (`.tmp-verify\module-probe.mjs`, self-signed
cert generated with `python .tmp-verify\make-cert.py`; the product's real
`startBridgeProxy` is the thing under test).

| probe | result (REV2) |
| --- | --- |
| `/__bridge/health` | `200 application/json` → `{"ok":true,"upstream":"https://chat.deepseek.com","port":34264}` |
| health forwarded upstream? | **never** — echo upstream's request log contains only `GET /`, `GET /not-found`, `POST /echo`, `GET /redirect` |
| `GET /?__bridge_session=<token>` | `302` + `Set-Cookie: dsh_bridge_session=…; Path=/; HttpOnly; SameSite=Lax`, `Location: /` |
| same, redirect followed (what a browser sees) | `200 text/html`, body contains `<title>DeepSeek</title>` |
| CSP / X-Frame-Options on the framed document | **absent** (`csp header present=False`, `x-frame-options present=False`), as are HSTS, COOP and CORP |
| script/link tags | **8** tags, `withIntegrity=0 withCrossorigin=0` |
| wrong session cookie | `403 bridge: no-session` |
| no cookie | `403 bridge: no-session` |
| valid cookie + `sec-fetch-site: cross-site` | `403 bridge: cross-site` |
| path that must not exist upstream | **`200 text/html`** — see nuance 1 |
| POST body, real upstream | proxied vs direct byte-identical responses for 5 bodies and a 6 925-byte body (`identical=True`), including the body-dependent field-level validator output |
| POST body, controlled upstream | `sent=4167 upstream=4167`, sha256 equal → **byte-exact** |
| `set-cookie` rewrite, real upstream | upstream sends `Secure`(+`SameSite=Strict`) and the proxy drops/rewrites it |
| `set-cookie` rewrite, controlled upstream | `hostcookie=2; Domain=.example.com; Path=/; Secure; HttpOnly; SameSite=Strict; Partitioned` → `hostcookie=2; Path=/; HttpOnly; SameSite=Lax` (Domain, Secure, Partitioned gone) |
| real 404 passthrough | controlled upstream `/not-found` → `404`, body unchanged |
| Location rewrite | `302 Location: http://127.0.0.1:52808/after` (bridge origin, not upstream) |
| browser cookie confidentiality | the GUI's `dsh-auth-*` cookie is **not** forwarded upstream; `authorization` **is**; `sec-fetch-*` dropped; `x-forwarded-host` added; `accept-encoding: identity` forced |
| module probe score | `checks=33 pass=32 fail=1` — the single FAIL is the hardening note D5 |

Raw, real upstream cookies (REV2):

```
  upstream Set-Cookie: HWWAFSESTIME=…; path=/; Secure; HttpOnly
  upstream Set-Cookie: HWWAFSESID=…; path=/; Secure; HttpOnly
  upstream Set-Cookie: ds_session_id=…; Path=/; HttpOnly; Secure; SameSite=Strict
  proxied Set-Cookie:  HWWAFSESTIME=…; path=/; HttpOnly
  proxied Set-Cookie:  HWWAFSESID=…; path=/; HttpOnly
  proxied Set-Cookie:  ds_session_id=…; Path=/; HttpOnly; SameSite=Lax
```

**Nuance 1 — "a path that must not exist upstream" cannot be produced on this upstream.**
`chat.deepseek.com` answers *every* path with `200 text/html` SPA shell, including
`/static/nope-9f3a1c.js` and `/api/v0/definitely-missing-9f3a1c` (proxied `200`, direct
`200`, both the SPA shell). The proxy is faithfully passing upstream status through — the
criterion's intent (no fake 404, no swallowing errors) is proven against a controlled
upstream where a real 404 arrives as 404. Consequence worth knowing: **deep links to
unknown paths render the SPA, not an error page.**

**Nuance 2 — `GET /?__bridge_session=<token>` is a 302, not a 200.** The proxy exchanges
the query token for an HttpOnly cookie and redirects to `/` so the token leaves the URL.
Any browser follows it and lands on `200 text/html`; a client that refuses redirects sees
302. This is deliberate and documented in `bridge-proxy.js`; the criterion is met in
browser-equivalent behaviour, not literally on the first hop.

### C8. Extras I probed beyond the criteria — all consistent

```
POST /api/session              -> 405 GET only        GET  /api/ticket -> 405 POST only
POST /api/account              -> 405 GET only        GET  /api/session (no cookie) -> 401
POST /api/ticket -> 200 {"url":"http://127.0.0.1:34264/?__bridge_ticket=6a490b7a…"}
first  redemption -> 302 set-cookie=dsh_bridge_session=…; Path=/; HttpOnly; SameSite=Lax location=/
second redemption -> 403 bridge: no-session          (one-shot ticket honoured)
9000-byte ticket body -> 413 {"code":"too-large"}    (8 KiB cap honoured)
```

`node E:\wyx_code\dsh-deepseek-chat-bridge\tests\unit-host.mjs` → **32/32 checks passed**
(host-side trust fence, cookie/Location rewrite, document rewrite, connection reuse).

Design claim checked directly: the raw upstream really does send
`content-security-policy: frame-ancestors 'none'`, `strict-transport-security: max-age=31536000; …`,
and two script tags with `crossorigin defer integrity="sha384-…" onerror="_sriCk(this)"`.
The proxy's reason to exist is therefore real, and removing exactly those two attributes
is what lets the document frame and its scripts execute.

---

## 2. Defects found (by severity)

**D1 — HIGH (functional, user-visible): the framed Chat app boots signed out.**
The panel loads the real app, which immediately lands on `/sign_in`; the user sees a login
form, not their conversations. Reading the frame's own auth state from inside the frame:

```
"href":"http://127.0.0.1:34264/sign_in"
appAuthCheck: {"status":200,"code":"40003","body":"{\"code\":40003,\"msg\":\"Authorization Failed (invalid token)\",\"data\":null}"}
```

`seeded:false` in the session route and the test profile supplies no seed, and
`lib/config.js`/`lib/account.js` document why (the desktop grant is a Platform token, not
a chat.deepseek.com session token) — so this is a **design limitation, not a coding bug**.
But the package description (“在 DSH GUI 内无缝切换到 DeepSeek Chat 网页版”) promises
more than the panel delivers: switching is seamless, being signed in is not. Either scope
the claim or provide a seed path.
Reproduce: open the panel, click CHAT, read `location.href` inside the frame.
Evidence: `.tmp-verify\rev2-cdp.png`, `.tmp-verify\cdp-followup-output.txt`.

**D2 — HIGH/MEDIUM: CORS-blocked subresources inside the framed app (fonts + wasm).**
The browser's own log (`Log.entryAdded`, which the product harness never enables):

```
[error/javascript] Access to font at 'https://fe-static.deepseek.com/chat/static/Inter-Regular-subset.25cc0f0e93.woff2'
  from origin 'http://127.0.0.1:34264' has been blocked by CORS policy: The 'Access-Control-Allow-Origin'
  header has a value 'https://*.deepseek.com' that is not equal to the supplied origin.
[error/network] Failed to load resource: net::ERR_FAILED  (same font)
[error/javascript] Access to fetch at 'https://fe-static.deepseek.com/chat/static/opus-decoder.mvp.2dc7300ee4.wasm'
  from origin 'http://127.0.0.1:34264' has been blocked by CORS policy: … 'https://*.deepseek.com' …
```

Root cause, measured with three `Origin` values (`node .tmp-verify\cors-probe.mjs`):

```
Origin: http://127.0.0.1:34264  -> acao="https://*.deepseek.com"   (literal wildcard, not a match)
Origin: https://chat.deepseek.com -> acao="https://chat.deepseek.com"
```

The CDN only reflects real DeepSeek origins. Scripts and CSS survive because the proxy
strips `crossorigin` (no-cors loads), but **fonts are always CORS-mode** and the wasm
decoder is fetched with CORS, so they cannot be rescued that way. Consequences: Inter
falls back to a system font, opus decoding (voice) is unavailable, and 3 red errors sit in
DevTools whenever the panel is open. Suggested direction (not applied — report only):
route `fe-static.deepseek.com` through a bridge path and rewrite the HTML/CSS references so
those assets become same-origin.
Evidence: `.tmp-verify\cdp-log-output.txt`, `.tmp-verify\cors-probe.mjs`.

**D3 — MEDIUM: WeChat QR login is broken inside the panel.**
The app builds the OAuth URL from the loopback origin, and WeChat rejects it:

```
https://open.weixin.qq.com/connect/qrconnect?appid=wx58f1d4bc57bc28fd&scope=snsapi_login
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A34264%2Fapi%2Fv0%2Fusers%2Foauth%2Fwechat%2Fcallback&…
```

The rendered QR panel shows literally **“redirect_uri 参数”** instead of a QR code
(visible in `.tmp-verify\rev2-cdp.png`). Phone/password login is untested (needs real
credentials), so the panel may still be usable — but the WeChat route is dead, and it is
the most prominent option on the sign-in page that D1 lands the user on.

**D4 — MEDIUM (process/evidence integrity): product files changed mid-verification.**
`bridge-proxy.js` 15:57:58, new `tests/unit-host.mjs` 15:58:07, `client.js` 16:03:49 —
all after my 15:57:43 freeze and after the Lead's own test instance had already booted
(15:55:01, serving a stale bundle). Mitigated by re-running everything on the final
revision (identical results) and by the hash freeze in §0. Risk if repeated: a verdict
attached to the wrong bytes. Recommend a hard freeze (or a commit) before verification
starts and no writes until the verifier reports.

**D5 — LOW (hardening): `sec-fetch-site` comparison is case-sensitive.**
`handle()` refuses only the exact lowercase `cross-site`. A request with `Cross-Site`
passes the fence if it also carries a valid session cookie:

```
FAIL  [hardening] mixed-case Cross-Site still refused
      status=200 body=<!doctype html><html lang="en" …>
```

Browsers always send lowercase, so this is defence-in-depth only (an attacker able to set
arbitrary request headers locally already has the cookie). Fix: `String(value).toLowerCase()`.

**D6 — LOW (evidence quality): `tests/verify-ui.mjs` cannot fail.**
It prints steps and unconditionally `process.exit(0)` — exit code 0 is not evidence, and
in both runs the step `first framed document response` printed `none recorded` while the
criterion was actually satisfied later in the run. It also inspects only
`Runtime.consoleAPICalled`/`exceptionThrown` and never enables `Log`, so the D2 CORS errors
are invisible to it. Recommend assertions + `Log.enable` + capturing the first frame
navigation's Document response.

**D7 — LOW: `/__bridge/health` is unauthenticated and answered before every fence.**
It returns the upstream origin and the bridge port to any local caller, and because the
`sec-fetch-site` check happens after the health branch, the cross-site rule does not apply
to it either. No credential leaks (`health leaks no credential` passes in `unit-host.mjs`),
so this is an information-exposure/port-probing nit; the session token still gates
everything else.

**D8 — INFO: the brief's “9 script/link tags” is 8.**
Every capture (raw upstream and proxied, four independent runs, two revisions) finds
**8** `<script|link>` tags, of which the raw upstream has 2 `integrity=` + 2 `crossorigin=`
and the proxied document has 0/0. Nothing is missing; the expected count in the brief is
off by one. Flagged so nobody “fixes” a non-bug.

---

## 3. Could not verify

1. **Byte-exact POST forwarding through the real upstream.** `chat.deepseek.com` has no
   echo endpoint; I proved semantic/field-level fidelity there (identical responses to
   direct requests, body-dependent validator output, 6 925-byte body) and proved
   byte-exactness (sha256 of 4 167 bytes incl. multibyte UTF-8) against a controlled HTTPS
   upstream through the product's own `startBridgeProxy`.
2. **`Domain`/`Partitioned` removal against the real upstream** — its cookies never carry
   those attributes (`Secure` + `SameSite=Strict` only). Removal of all three is proven
   with a controlled `Set-Cookie`; on the real upstream only `Secure` removal and
   `Strict→Lax` are observable.
3. **Degraded account paths** (`no-grant`, `issuer-mismatch`, `unauthorized`,
   `read-failed`) — would require mutating or hiding `C:\Users\wanyexin\.dsh\.credentials.yaml`,
   which is outside my scope. Only the signed-in happy path was exercised.
4. **Phone-number / password login inside the framed panel** (D3's alternative) — needs a
   real credential and would send an SMS/consume an attempt.
5. **The Electron desktop shell.** All browser evidence is headless Edge/Chromium; I did
   not attach to the user's live desktop app (explicitly prohibited), so DSH-desktop-specific
   rendering (menus, native window chrome, BrowserView vs iframe behaviour) is unverified.
   The client bundle is plain DOM/React and the DSH web shell is what both GUIs share, so
   risk is low but not zero.
6. **Long-run stability** (SSE streaming through the proxy over minutes, connection-pool
   exhaustion, ticket TTL expiry at 120 s) — only short bursts (6 sequential requests,
   408 ms total) and one-shot ticket semantics were exercised.
7. **Whether the bundle logs errors that occurred before CDP attached** — both harnesses
   enable `Runtime` after target creation; early-boot errors would be missed. Two
   independent runs plus the `Log`-domain run reported none, so this is a small residual gap.

---

## 4. Evidence index (all verifier-owned, inside my write scope)

| file | content |
| --- | --- |
| `.tmp-verify\config-unit.mjs` / output in report | 27-case `lib/config.js` probe |
| `.tmp-verify\probe-proxy.ps1`, `rev2-proxy.txt` | PowerShell proxy suite (health, framing, 403s, tags, cookies) |
| `.tmp-verify\probe-proxy2.ps1`, `rev2-proxy2.txt` | 404 paths, POST body oracle, upstream cookie survey |
| `.tmp-verify\make-cert.py`, `echo-key.pem`, `echo-cert.pem` | self-signed cert for the controlled upstream |
| `.tmp-verify\module-probe.mjs`, `rev2-module.txt` | 33 checks driving the product's `startBridgeProxy` against that upstream |
| `.tmp-verify\cors-probe.mjs`, output in report | CDN `access-control-allow-origin` per `Origin` (D2 root cause) |
| `.tmp-verify\cdp-verify.mjs`, `rev2-cdp.txt`, `rev2-cdp.png` | independent CDP harness (criteria C1–C4, in-frame DOM) |
| `.tmp-verify\cdp-followup.mjs`, `cdp-followup-output.txt` | raw upstream headers; framed-app auth state (D1) |
| `.tmp-verify\cdp-log.mjs`, `cdp-log-output.txt` | browser `Log` domain errors (D2) |
| `.tmp-verify\extras.ps1`, `extras-output.txt` | method gates, ticket flow, 8 KiB cap, paired account check, hashes |
| `.tmp-verify\rev2-verify-ui.txt`, `rev2-verify-ui.png` | product harness output on the final revision |
| `.tmp-verify\rev2-unit-host.txt` | Lead's `tests/unit-host.mjs`, 32/32 on the final revision |
| `.tmp-verify\boot-verifier2.log`, `boot-verifier2.err.log` | REV2 boot log (token, listening state) |

No product file was modified by the verifier. Test instance on port 19389 was stopped
after the final run.

---

# REV3 verification — CORS/static-origin fix on the frozen revision

- Verifier: `verifier` teammate (wrote no product code; report only)
- Shared task: `task-5`
- Window: 2026-10-10 16:20 → 16:42 (+08:00)
- Verdict: **all six task-5 items PASS on the frozen revision.** D2 (CORS-blocked fonts/wasm) is
  fixed and independently reproduced as fixed; D5 (case-sensitive `sec-fetch-site`) is fixed;
  the keep-alive pooling claim is confirmed. Two **new** defects were found in the rewritten
  code (both latent), and the task-4 carry-overs are unchanged.
- Safety: the live desktop app (PID 26192 tree: 28104/28136/28288/4104, port 19387) was never
  stopped, restarted or attached to; nothing outside the repo, `.tmp-verify` and the
  `chatbridge-test` profile was read or written. Port 19391 (mine) was stopped at the end;
  the Lead's 19390 instance was left running.

---

## 0. Frozen revision and the churn that preceded it

The task asked to verify the **frozen** revision, so every criterion below was re-run after
the freeze was confirmed stable. Hashes as verified (unchanged 16:33:25 → 16:42:33):

| artifact | SHA-256 | mtime |
| --- | --- | --- |
| `lib/bridge-proxy.js` | `4614E695F344E905A80DE6E89ADEC2C846A920569B07993F51D5D34202511A68` | 16:13:48 |
| `lib/client.js` | `7DC0B6F60CD87357AB2FDA48C0076A4439F2E16F5F7DE395292B721330CBB505` | 16:33:25 |
| `tests/verify-ui.mjs` | `ED212A95C13486A89D9568FB16A7BA7AFB007A3C65A3803A1E15BEFF74CB8084` | 16:18:00 |
| `tests/unit-host.mjs` | `54682980B3EA1A49F7BF8577A9F31EB613C30D87F3F1C75A12C8811C02BADB27` | 16:13:52 |
| `tests/diag-inert.mjs` | `1A42DA0AD6CAB776C6316178F64263BF3E18B13E7BF42B584E79315AE56A242B` | 16:30:35 |
| `tests/diag-fonts.mjs` | `9D803DE6E2F58B467A7CB42662B149CF7DC011E9AFC69AAA845F0D61A98CA386` | 16:15:49 |
| `tests/shot-panel.mjs` | `F8C7FD8124BF640EB4820CD8B04FD9B92B38846C8C6F3B1E5C51EBE2596BF7CF` | 16:19:22 |
| `lib/index.js` | `F509751123A53984C91FB58265051EFB9BE0EE13FA3109BC1ACF535D8305E606` | 15:46:57 |
| `lib/account.js` | `5CD107818C4952F16931E9B1D03DCD713A58334B78EE5241D70663A25C274F2C` | 15:34:00 |
| `lib/config.js` | `9BE1B09363CFFF39CF050F74EF994C1F973618FE9C09515182900C226E31880D` | 15:42:09 |
| `lib/shared.js` | `0E153F2FD3F64076B1886146C5C1D4BB1C677641C83110ADAEF69D01332C3D3E` | 15:34:25 |
| `package.json` / `cordis.patch.yml` / `dsh.plugin.json` | `DDA8638E…` / `6B249DA3…` / `1B4CD834…` | 15:33–15:34 |

**Churn history (for the record, and the reason every number below names its hash).**
`lib/client.js` was written five times while verification was in flight — 16:03:49, 16:25:38,
16:28:18, 16:31:00, 16:33:25 — after task-5's description was written and after my first REV3
hash freeze at 16:20:35 (`491F3296…`). `lib/bridge-proxy.js` (the artifact that implements the
D2 fix) was **stable at `4614E695…` from 16:13:48 onward**, so all proxy-level evidence is
bound to the frozen bytes. The browser half changed under me, so the browser criteria were
re-run in three separate sessions (fresh Edge profile, cache disabled) across three client
revisions — `491F3296`, `4CF16AC5`, `7DC0B6F6` — with **identical results each time**, and then
re-run once more after the freeze settled, which is the evidence quoted below.

Instances: my own `chatbridge-test` GUI on **19391** (booted 16:36:22, bridge origin
`http://127.0.0.1:34264`) and the Lead's on **19390** (booted 16:35:35, bridge origin
`http://127.0.0.1:60573` — its preferred port was taken, so the OS-assigned fallback path in
`lib/index.js` ran; both were booted after the 16:33:25 client write and therefore serve the
frozen bundle).

---

## 1. `node tests/unit-host.mjs 35591` → 37/37, exit 0 — **PASS**

```
EXITCODE=0
PASS  config defaults
PASS  config seed map
PASS  config rejects non-object config
PASS  config rejects array config
PASS  config rejects target without scheme
PASS  config rejects target with path
PASS  config rejects port negative
PASS  config rejects port too large
PASS  config rejects port fractional
PASS  config rejects timeout zero
PASS  config rejects empty credentialsPath
PASS  config rejects seed with non-string
PASS  health returns json  {"ok":true,"upstream":"https://chat.deepseek.com","port":35591}
PASS  health leaks no credential
PASS  no session -> 403  403
PASS  cross-site -> 403  403
PASS  wrong token -> 403  403
PASS  token exchange redirects  302
PASS  session cookie is HttpOnly  "dsh_bridge_session=unit-token-0123456789abcdef; Path=/; HttpOnly; SameSite=Lax"
PASS  document served  200
PASS  no content-security-policy
PASS  no x-frame-options
PASS  no hsts
PASS  no integrity/crossorigin on tags  []
PASS  external scripts keep src + onerror
PASS  seed script precedes the app scripts  118
PASS  set-cookie rewritten for http loopback  ["HWWAFSESTIME=…; path=/; HttpOnly","HWWAFSESID=…; path=/; HttpOnly","ds_session_id=…; Path=/; HttpOnly; SameSite=Lax"]
PASS  document references the static route, not the CDN  9
PASS  static css served same-origin  "200 291436B text/css; charset=utf-8"
PASS  served css points its fonts at this proxy  "8 font-face rules, 8 rewritten refs"
PASS  referenced font asset reachable same-origin  "no font URL in the shell document (loaded at runtime)"
PASS  served script has CDN references rewritten  1
PASS  api path preserved  {"code":40002,"msg":"Missing Token","data":null}
PASS  unknown upstream path reports upstream status  200
PASS  post reaches upstream  429
PASS  six proxied requests complete  "383ms total"
PASS  ticket endpoint owned by the host half (not the proxy)

37/37 checks passed
```

## 2. `node tests/verify-ui.mjs http://127.0.0.1:19390 <token> <shot>` → 13/13, exit 0 — **PASS**

```
EXITCODE=0
== capsule rendered
   [{"label":"对话","pressed":"true"},{"label":"CHAT","pressed":"false"}]
== chat iframe mounted
   http://127.0.0.1:60573/?__bridge_session=ea849a61…
== framed document responses
   [{"url":"http://127.0.0.1:60573/?__bridge_session=ea849a61…","status":200,"type":"Document","mimeType":"text/html"}]
== framed subresources from fe-static
   0
== framed assets served same-origin
   ["200 main.1d00a4d01e.css","200 default-vendors.df13be609e.js","200 main.8d6a4f4bfa.js","200 katex.effce08cb3.css",
    "200 katex.ef343f2527.js","200 Inter-Regular-subset.25cc0f0e93.woff2","200 Inter-Medium-subset.43ff37cb99.woff2",
    "200 87321.87453ce690.js","200 default-vendors.df13be609e.js","200 main.8d6a4f4bfa.js","200 main.1d00a4d01e.css","200 katex.effce08cb3.css"]
== framed assets still fetched from the CDN
   0
== failed frame requests
   [{"error":"net::ERR_ABORTED"} ×6]
== real frame failures (aborted navigations excluded)
   none
== CORS refusals in the page log
   none
== any log entry naming the CDN
   none
== after switching back
   {"overlayPresent":true,"overlayVisible":false,"inertChildren":0,"frameStillMounted":1}
== console errors
   none
== assertions
   13/13 passed
```

Both Inter woff2 fonts appear in the same-origin asset list, zero CDN fetches, no CORS
refusal, no log entry naming the CDN. The same 13/13 + exit 0 was reproduced on my own
19391 instance, and on the earlier client revisions noted in §0.

**The "exits non-zero on failure" claim is real, not just documented** — same `verify-ui.mjs`
hash, bogus token:

```
node tests/verify-ui.mjs http://127.0.0.1:19391 bogus-token-xyz ...   -> EXITCODE=1
Error: timeout waiting for shell buttons
    at waitFor (…/tests/verify-ui.mjs:162:38)
```

## 3. Independent CORS proof (not trusting the product harness) — **PASS**

My own CDP harness (`.tmp-verify\rev3-cdp.mjs`, written before this task, fresh Edge
user-data-dir, `Network.setCacheDisabled(true)`, `Log` domain enabled) against the frozen
revision on 19391:

```
== 4. exact URLs for the Inter woff2 fonts and the opus wasm
{"fonts":[
 "200 font/woff2 diskCache=false http://127.0.0.1:34264/__bridge_static/chat/static/Inter-Regular-subset.25cc0f0e93.woff2",
 "200 font/woff2 diskCache=false http://127.0.0.1:34264/__bridge_static/chat/static/Inter-Medium-subset.43ff37cb99.woff2"],
 "opus":[
 "200 text/javascript diskCache=false http://127.0.0.1:34264/__bridge_static/chat/static/opus-decoder-wasm.cf0bf84ddc.js",
 "200 application/wasm diskCache=false http://127.0.0.1:34264/__bridge_static/chat/static/opus-decoder.mvp.2dc7300ee4.wasm"]}
== 5. every host the framed app contacted
["127.0.0.1:19391","127.0.0.1:34264","castatic.fengkongcloud.cn","res.wx.qq.com","apm.volccdn.com",
 "lf3-data.volccdn.com","open.weixin.qq.com","apmplus.volces.com","","appleid.cdn-apple.com",
 "fp-it-acc.portal101.cn","gator.volces.com"]          <-- no fe-static.deepseek.com
== 6. requests from the frame to fe-static.deepseek.com
{"count":0,"urls":[]}
== 7. Log entries mentioning Access-Control
none
== 8. all Log.entryAdded errors
[]
== 9. loadingFailed (non-aborted)
[]
== 10. console.* errors / uncaught exceptions
none
== 11. fonts actually applied inside the frame
{"fontFaces":["Inter / loaded / 400", … "Inter / loaded / 500", … "quote-cjk-patch / error / normal"],
 "fontResources":["…Inter-Regular-subset.25cc0f0e93.woff2 transfer=28368 type=css",
                  "…Inter-Medium-subset.43ff37cb99.woff2 transfer=28932 type=css",
                  "…opus-decoder.mvp.2dc7300ee4.wasm transfer=94701 type=fetch"],
 "docFontsStatus":"loaded","interRegularUsable":true}
```

So the fix is not merely "the request returns 200": both Inter faces reach **`loaded`** state,
`document.fonts.status === "loaded"`, `document.fonts.check('16px Inter') === true`, and the
wasm is fetched same-origin as `application/wasm`. The CDN is never contacted by the frame.

Supporting rewrite evidence (`.tmp-verify\rev3-static-probe.mjs`, frozen bridge):

```
PASS  static JS served same-origin      status=200 ct=text/javascript bytes=1547808
PASS  served JS has no CDN references   cdnRefs=0 routeRefs=1
PASS  served CSS has no CDN font references  status=200 cdnRefs=0 @font-face=8 routeFontRefs=8
PASS  no absolute font URL survives in the served CSS  []
PASS  Inter-Regular-subset.25cc0f0e93.woff2 same-origin  200 font/woff2 bytes=28068
PASS  Inter-Medium-subset.43ff37cb99.woff2 same-origin   200 font/woff2 bytes=28632
```

Every one of the 68 `url(...)` font sources across the two served stylesheets is now a
relative `/__bridge_static/...` path.

**One loose end investigated and dismissed:** the `quote-cjk-patch` face reports
`status: error`. It is not declared in either served stylesheet, it produced **no network
request** (`loadingFailed` is empty, no `.woff2` resource entry for it, no CORS log), so it is
an app-side artifact (a font face the app constructs itself) and **not** attributable to the
proxy or to a missed rewrite.

## 4. The static route cannot be abused — **PASS**

Raw-socket hostile request lines (`nc`-equivalent, so nothing normalises the path first) plus
normal authenticated fetches:

```
PASS  static asset without cookie -> 403            status=403 body=bridge: no-session
PASS  static asset cross-site -> 403                status=403 body=bridge: cross-site
PASS  raw "/__bridge_static/%2e%2e%2f%2e%2e%2fetc%2fpasswd" -> 400, no local file
      400  localFileLeak=false bytes=154            (openresty 400 from the static host)
PASS  raw "/__bridge_static/....//....//etc/passwd" -> 404, no local file   (S3 NoSuchKey XML)
PASS  raw "/__bridge_static//..//..//etc/passwd" -> 404, no local file
PASS  raw "/__bridge_static/..%5c..%5cWindows%5cwin.ini" -> 404, no local file
PASS  raw "http://evil.example/steal" -> 200, no local file     (SPA shell — chat upstream)
PASS  raw "//evil.example/steal" -> 200, no local file          (SPA shell — chat upstream)
PASS  override headers do not redirect the upstream host  status=200
```

The two paths that normalise **out** of the prefix (`/__bridge_static/../../etc/passwd` →
`/etc/passwd`) are answered by the **chat** origin, proven by attribution:

```
GET https://chat.deepseek.com/etc/passwd        -> 429 (rate-limited after my probing; SPA-style body)
GET https://fe-static.deepseek.com/etc/passwd   -> 404 <?xml …<Code>NoSuchKey</Code>…
proxied /__bridge_static/../../etc/passwd       -> 429  (matches the chat origin, not the CDN)
proxied /__bridge_static/%2e%2e%2f…/etc/passwd  -> 400  server: openresty  (matches the static host)
```

My script printed two `FAIL` lines for the 429 cases purely because its status whitelist did
not include 429; `localFileLeak=false` in both, and the attribution above shows the request
went to the chat upstream. **Substance: PASS — no traversal, no local file, and the upstream
host is hard-coded per route so the path prefix cannot be used as an open proxy.**

## 5. Regression re-check — **PASS**

| check | observed (frozen revision) |
| --- | --- |
| capsule labels / state | `["对话:true","CHAT:false"]` |
| takeover covers the frame | `{"top":0,"left":0,"width":1250,"height":805,"viewport":[1250,805]}` |
| inert selection | exactly 1 subtree, `970×805` (and `970×765` on the 1280×860 diagnostic window) |
| capsule outside inert, hit-testable | `insideInert:false`, all three controls hit their own button |
| shell not clickable behind the takeover | `elementFromPoint` mid-panel returns the IFRAME inside the overlay |
| switch back to 对话 | overlay `visibility:hidden`, `pointerEvents:none`, `globalInertCount:0` |
| iframe kept alive | `sameFrameNode:true`, `frameCount:1`, `documentsBefore/After 3/3` (no reload) |
| account route vs independent HTTPS | field-by-field match `id/name/mobile/balance/currency/bonus` = all `True` (live balance matched at the same instant) |
| token containment | account route `False`, session route `False`, `sessionToken == grant` `False`, 0 hits in `lib/`, `False` in both boot logs |
| route gates | `POST /api/session → 405 GET only`, `GET /api/ticket → 405 POST only`, `POST /api/account → 405 GET only`, session route without GUI cookie → `401` |
| ticket flow | mint `200`, first redemption `302` + cookie, second redemption `403 bridge: no-session`, 9000-byte body → `413 {"code":"too-large"}` |
| `lib/config.js` | `cases=27 threw=18` — unchanged (artifact unchanged) |
| pooling (module, controlled upstream) | 10 sequential requests → **1** TCP connection, 1 client port |
| pooling (live static agent) | 12 sequential 1.5 MB asset fetches → **1** distinct local port to :443, 1 established socket |
| inert ancestry on the Lead's layout | `tests/diag-inert.mjs` → single `INERT` child `970×765` at depth 3 with `holdsCapsule:false`; every node on the capsule's own chain `selfInert:false` |

## 6. Defects

**D5 (from task-4) — FIXED and verified live.** Six header spellings against the frozen
bridge with a valid cookie:

```
Sec-Fetch-Site: same-origin -> 200 <!doctype html…      (control: cookie is valid)
Sec-Fetch-Site: cross-site  -> 403 bridge: cross-site
Sec-Fetch-Site: Cross-Site  -> 403 bridge: cross-site
Sec-Fetch-Site: CROSS-SITE  -> 403 bridge: cross-site
Sec-Fetch-Site:  cross-site  -> 403 bridge: cross-site
Sec-Fetch-Site: cross-Site  -> 403 bridge: cross-site
```

**NEW — D-REV3-1 (MEDIUM, latent): absolute `Location` rewriting is broken.**
REV3 passes `upstreamTarget.referer` (= target origin **plus the request path**) as the prefix
`rewriteLocation` matches, where REV2 passed the bare origin. Deterministic reproduction with
a controlled upstream (`node .tmp-verify\rev3-location.mjs`):

```
request path   upstream Location          -> returned to the browser      rewritable?
/              https://127.0.0.1/chat     -> http://127.0.0.1:58395chat   yes, but MALFORMED
/sign_in       https://127.0.0.1/chat     -> https://127.0.0.1/chat       NO — escapes the bridge origin
/deep/a/b      https://127.0.0.1/chat     -> https://127.0.0.1/chat       NO — escapes the bridge origin
/rel           /sign_in                   -> /sign_in                     n/a (root-relative is correct)
/same          https://127.0.0.1/same     -> http://127.0.0.1:58395       yes
```

When the prefix does match, the leading `/` is consumed by the prefix and the result is an
invalid URL (`:58395chat`); when the Location's path differs from the request path, the
redirect is handed to the frame unchanged and the browser leaves the bridge origin (losing the
session cookie). The static branch passes the constant `https://fe-static.deepseek.com/`, so any
absolute static redirect is mangled the same way.
**Why it is latent:** today's upstream only emits *root-relative* redirects —
`GET /api/v0/users/oauth/wechat/callback → 307 location=/sign_in?provider=WECHAT&code=99&error=CODE_IS_NONE`
and the Google equivalent; `/`, `/sign_in`, `/chat`, `/download`, `/api/v0/users/current` all
return `200` with no `Location`, and I could not find an absolute one. So the common flows are
unaffected, but any future absolute redirect breaks the frame. One-line fix: pass the bare
origin and join with `/`.

**NEW — D-REV3-2 (LOW-MEDIUM): `target`'s scheme and port are ignored.**
`forward()` hardcodes `protocol: 'https:'` and `port: 443`; `lib/config.js` still validates and
accepts `http:` targets and any port, and `startBridgeProxy`'s JSDoc advertises `options.target`
as the upstream origin. Proven with a controlled upstream on `127.0.0.1:443`:

```
PASS  target https://127.0.0.1:5555 is NOT dialled on 5555 — request landed on 443
PASS  target http://127.0.0.1 is dialled over TLS anyway   (config.js accepts http: targets)
```

Only the default `https://chat.deepseek.com` deployment is unaffected; the practical costs are
(a) a configured non-443/http upstream silently talks to `https://<host>:443`, and (b) the
module can no longer be pointed at a local test upstream, which is why my task-4 module-probe
technique had to move to port 443.

**Carried over, unchanged, not part of this fix:** D1 the framed Chat app still boots signed
out on `/sign_in` (`{"code":40003,"msg":"Authorization Failed (invalid token)"}`, `seeded:false`)
— a documented design limitation; D7 `/__bridge/health` is still unauthenticated and answered
before every fence; D8 the shell document still has **8** `<script|link>` tags, not 9.

**Accepted as known, per the Lead:** the harness's `first framed document response: none
recorded` line (my own harness records the framed `200 text/html` Document response
independently), and the WeChat QR `redirect_uri 参数` failure (structural — WeChat must
whitelist the redirect_uri, so a loopback origin can never satisfy it). Both are documented
limitations, not defects.

## 7. Could not verify

1. **The staged-desktop shell layout** that motivated the `inert` fix. I have no staged desktop
   profile, so I could not reproduce that specific DOM; instead I verified the invariants it
   targets on the available layout with two independent instruments (my CDP harness and the
   Lead's `diag-inert.mjs`): exactly one large inert sibling, no inert ancestor of the capsule,
   capsule hit-testable, panel closable. The Lead's 12/13 dry run (single failure
   `account readout is a real account`) is consistent with an isolated `DSH_HOME` with no
   credential store and is outside my evidence loop.
2. **Byte-exact POST bodies through the real upstream** — unchanged from task-4: no echo
   endpoint exists there; proven byte-exact against a controlled upstream, semantically
   identical against the real one.
3. **Long-run behaviour** — SSE turns over minutes, pooled-socket recycling under load, and
   ticket TTL expiry; only short bursts (6–12 requests) were exercised.
4. **The Electron desktop shell** — all browser evidence is headless Edge; the live desktop app
   was off-limits.
5. **`quote-cjk-patch`** — could not attribute its `error` state to any network activity; it has
   no network footprint in my traces, so I can only say it is not the proxy.

## 8. Evidence index (verifier-owned, `.tmp-verify` unless noted)

| file | content |
| --- | --- |
| `frozen-unit-host.txt` | 37/37, exit 0 (item 1) |
| `frozen-verify-ui-19390.txt`, `frozen-verify-ui-19390.png` | product harness 13/13 on 19390 (item 2) |
| `rev3c-verify-ui.txt`, `rev3d-verify-ui.txt` | the same 13/13 on earlier client revisions |
| `rev3-failpath.txt` | harness exit 1 on a bogus token |
| `frozen-cdp.txt`, `frozen-cdp.png` | my independent CDP proof on the frozen revision (item 3 + regressions) |
| `rev3-static.txt` / `frozen-static.txt` | static-route rewrite, traversal and auth probes (item 4) |
| `rev3-fontgap.mjs` | the `quote-cjk-patch` investigation |
| `rev3-cdp.mjs` | independent browser harness (fresh profile, cache disabled, Log domain) |
| `rev3-location.mjs` | deterministic proof of D-REV3-1 |
| `module-probe-rev3.mjs`, `rev3-module.txt` | pooling, D5 folding, target contract, REV2 checks re-run (D-REV3-2) |
| `rev3-extras.ps1`, `rev3-extras.txt` | route gates, ticket flow, account cross-check, token containment |
| `rev3-static-probe.mjs` | raw-socket hostile request lines |
| `rev3-extras.ps1`, `config-unit.mjs` | config validator (27 cases) |
| `frozen-diag-inert.txt` | Lead's `diag-inert.mjs` on 19390 (inert ancestry) |
| `boot-rev3*.log` | my instance boot logs (tokens, listener PIDs) |
| `docs/VERIFICATION.md` | task-4 report (D1–D8, revision REV2) |

No product file was modified by the verifier; the 19391 listener and all headless Edge
processes I started were stopped; the desktop app still owns 19387 (PID 4104) with all five
PIDs alive.

---

# REV4 delta — D-REV3-1 / D-REV3-2 fixes (appended 2026-10-10 16:55)

Frozen bytes, matching the Lead's list exactly (my own freeze agreed before the run):

| artifact | SHA-256 | note |
| --- | --- | --- |
| `lib/bridge-proxy.js` | `8ACC8EC78160FC26FDF43567BF74D76A056B0E138F5441B588A49F8EDFF14EE2` | 16:44:36, 18810 B — **the only product file changed by this delta** |
| `tests/unit-upstream.mjs` | `3E71F3D281A810C454ECE299C4D94822A5C4A4F03B72BEBD4F522BDA4C699150` | new controlled-upstream harness |
| `lib/client.js` | `7DC0B6F60CD87357AB2FDA48C0076A4439F2E16F5F7DE395292B721330CBB505` | unchanged since the REV3 verification above |
| `tests/unit-host.mjs` / `tests/verify-ui.mjs` | `54682980…` / `ED212A95…` | unchanged |
| `lib/index.js`, `account.js`, `config.js`, `shared.js`, `package.json`, `cordis.patch.yml` | `F5097511…`, `5CD10781…`, `9BE1B093…`, `0E153F2F…`, `DDA8638E…`, `6B249DA3…` | unchanged |

## (a) D-REV3-1 FIXED — absolute `Location` rewriting

`node .tmp-verify\rev4-delta.mjs` (controlled HTTPS upstream on a random port; same matrix that
produced `http://127.0.0.1:58395chat` and three pass-throughs on REV3):

```
PASS  /abs -> http://127.0.0.1:64366/chat                         status=302
PASS  /sign_in/abs -> http://127.0.0.1:64366/chat                 status=302
PASS  /deep/a/b/abs -> http://127.0.0.1:64366/chat                status=302
PASS  /absquery -> http://127.0.0.1:64366/sign_in?from=absolute   status=302
PASS  /absbare -> http://127.0.0.1:64366                          status=302
PASS  every rewritten Location is a valid URL on the bridge origin (no "<origin><path>" join)
      5/5 ["…/chat","…/chat","…/chat","…/sign_in?from=absolute","http://127.0.0.1:64366"]
PASS  root-relative Location stays root-relative                  location=/sign_in
PASS  Location on a foreign origin is passed through untouched    location=https://other.example/steal
```

Every request path now rewrites correctly, the join is well-formed, and no case produces the
malformed `origin+path` string the REV3 probe caught.

## (b) D-REV3-2 FIXED — configured scheme and port are dialled

```
controlled HTTPS upstream on 127.0.0.1:64365 (random port, NOT 443)
PASS  request reached the configured random port   status=200 upstreamPorts=[64365]
PASS  Host header is the full authority host:port  host=127.0.0.1:64365
PASS  referer is the upstream origin + path        referer=https://127.0.0.1:64365/port-check
=== plain-HTTP target on 127.0.0.1:64384 ===
PASS  http:// target dialled over plain HTTP on the configured port   status=200 upstreamPorts=[64365,64384]
PASS  Location rewriting also correct on an http target              location=http://127.0.0.1:64385/chat
```

Default `https://chat.deepseek.com` path still works — my own 19391 instance booted on the
frozen bytes (bridge origin `http://127.0.0.1:62550`):

```
GET /                        -> 200 text/html; charset=utf-8, 9505 B
                                <title>DeepSeek</title>=True, "/__bridge_static/"=True, "fe-static.deepseek.com"=False
/__bridge_static/chat/static/main.1d00a4d01e.css                   -> 200 text/css 291438 B
/__bridge_static/chat/static/Inter-Regular-subset.25cc0f0e93.woff2 -> 200 font/woff2 28068 B
/__bridge_static/chat/static/Inter-Medium-subset.43ff37cb99.woff2  -> 200 font/woff2 28632 B
/__bridge_static/chat/static/main.8d6a4f4bfa.js                    -> 200 text/javascript 1547808 B
```

## (c) `node tests/unit-upstream.mjs` — exit 0, 8/8

```
PASS  plain request reaches the configured origin  {"status":200,"upstreamHost":"127.0.0.1:63556","upstreamPort":63556,"expectedHost":"127.0.0.1:63556"}
PASS  referer is rewritten to the upstream origin  "http://127.0.0.1:63556/echo"
PASS  post body forwarded
PASS  post payload arrives byte-exact  "{\"ok\":true,\"body\":\"{\\\"hello\\\":\\\"world\\\"}\"}"
PASS  absolute Location rewritten to the bridge origin  {"status":302,"location":"http://127.0.0.1:63557/sign_in?from=absolute"}
PASS  second absolute Location also rewritten  "http://127.0.0.1:63557/chat"
PASS  upstream 404 passes through with its body  {"status":404,"body":"not found upstream"}
PASS  Domain/Secure/Partitioned stripped from set-cookie  ["a=1; Path=/; HttpOnly; SameSite=Lax"]
8/8 checks passed
```

Also re-run on the frozen bytes: `node tests/unit-host.mjs 35597` → **exit 0, 37/37** (real
upstream, no regression), and my static-route probe → unchanged (403 without cookie, 403
cross-site, traversal contained with `localFileLeak=false`, CDN 400/404 attribution intact).

## (d) New defects introduced by this delta — **none found**

Two edge cases surfaced while probing the new `rewriteLocation`. Both are **pre-existing**
(the string-prefix `value.startsWith(upstreamOrigin)` is the same shape as REV2/REV3), both
need the trusted upstream itself to emit a crafted `Location`, and neither is a regression:

1. No-port upstream origin + same-prefix host: `Location: https://127.0.0.1.evil.example/steal`
   → `http://127.0.0.1:64389:443.evil.example/steal`, an invalid URL — fails closed.
2. Userinfo form: `Location: https://127.0.0.1@evil.example/steal` →
   `http://127.0.0.1:64389:443@evil.example/steal`, which parses with host `evil.example`.
   The *unmodified* upstream Location is also `evil.example`, so the rewrite does not create
   that destination — the frame would reach the same host either way.

Optional hardening only (not a blocker, not required for this delta): compare
`new URL(value).origin === upstreamOrigin` rather than a string prefix.

Harness note for anyone reading the raw capture: my first delta run printed 7 FAILs because my
echo routed `/absother`/`/abscollide` into the `/abs` branch — my routing bug, fixed in the
corrected run quoted above. The instance I booted on 19391 for this delta was stopped
afterwards; the Lead's 19390 instance was left running; the desktop app was untouched.
