# Supabase 연결과 첫 관리자 설정

이 문서는 새 Supabase 프로젝트를 Senmiva에 연결하는 절차입니다. 개발용 로컬 Supabase와 클라우드는 같은 코드와 정규화된 스키마를 사용합니다. 실제 데이터베이스를 사용해도 피부 분석은 명시적으로 표시되는 mock이며, 고객 사진은 업로드하거나 저장하지 않습니다.

## 먼저 준비할 것

실제 수신함으로 인증 메일을 받으려면 [이메일 발송 설정](EMAIL-SETUP.md)을 먼저 참고하세요. 현재 선택한 발송 방식은 Gmail SMTP입니다. Google 2단계 인증과 앱 비밀번호를 사용하므로 새 발신 도메인은 필요하지 않습니다. 로컬 데이터베이스를 유지하면서도 실제 메일을 발송할 수 있습니다. 일반 Google 비밀번호나 앱 비밀번호를 채팅에 보내지 마세요.

1. [Supabase Dashboard](https://supabase.com/dashboard)에서 계정에 로그인하고 **Senmiva 전용 빈 프로젝트**를 만듭니다. 회사·고객 데이터의 운영 국가와 정책에 맞는 리전을 선택합니다. 프로젝트 생성/요금제 선택은 계정 소유자가 진행합니다.
2. 프로젝트의 **Connect**에서 데이터베이스 연결 문자열을 복사합니다. 관리자 설정은 Direct 또는 Session pooler를 사용합니다. IPv4 환경에서는 Dashboard가 제공하는 Session pooler 주소를 사용하고, 호스트를 임의로 조합하지 않습니다. 포트 6543의 Transaction pooler는 이 설정 스크립트가 거부합니다. 비밀번호의 URL 예약 문자는 percent-encode해야 합니다. [공식 연결 안내](https://supabase.com/docs/guides/database/connecting-to-postgres)
3. 프로젝트 URL, **publishable key**, 데이터베이스 관리자 비밀번호를 준비합니다. 데이터베이스 비밀번호나 service-role/secret key를 채팅에 붙여 넣지 않습니다. 앱에 service-role key가 필요하지 않습니다.
4. **Authentication → Users → Add user**에서 첫 관리자의 이메일과 비밀번호로 사용자를 만들고 이메일 확인을 완료합니다. 사용자 UUID를 수동으로 SQL에 붙여 넣을 필요 없이, 아래 설정 도구가 확인된 이메일을 조회합니다. 이 도구는 Auth 사용자를 만들거나 비밀번호를 저장하지 않습니다.
5. **Authentication → Sign In / Providers**에서 **Email provider**, **Allow new users to sign up**, **Anonymous sign-ins**, **Confirm email**을 켜고 수동 identity linking은 끕니다. 비밀번호 최소 길이는 12자로 설정합니다. 사업자는 이메일을 확인한 뒤 새 회사·첫 매장을 직접 만들 수 있습니다. 가입만으로 기존 회사의 직원 권한이 생기지 않습니다. Email provider를 끄면 기존 직원의 비밀번호 로그인도 차단됩니다. 익명 Auth는 고객별 계정이 아니라 키오스크 기기의 신원이며, RLS가 서버의 `is_anonymous` 값과 실제 페어링을 함께 확인합니다. [공식 익명 인증 안내](https://supabase.com/docs/guides/auth/auth-anonymous)
6. **Database → Extensions**에서 `pg_cron`을 켭니다. 설정 도구가 1분마다 개인정보 정리 작업을 등록합니다. 이 확장이 없으면 tenant/owner/writer 초기화 트랜잭션을 중단합니다. [공식 pg_cron 안내](https://supabase.com/docs/guides/database/extensions/pg_cron)

관리자 비밀번호를 잊은 경우 현재 MVP에는 공개 비밀번호 재설정 화면이 없습니다. 프로젝트 관리자가 Supabase Auth 관리 절차로 복구합니다. 담당자 추가·역할 변경 UI는 별도 후속 기능이며, 계정 생성만으로 직원 권한이 부여되지 않습니다.

공개 사업자 가입을 제공하는 클라우드는 **Authentication → Email → SMTP Settings**에서 회사가 관리하는 발신 도메인과 SMTP 서비스를 연결합니다. Supabase의 기본 메일 발송은 허용 수신자와 발송량에 제한이 있으므로 임의 사업자에게 전달되는 운영 메일로 가정하지 않습니다. SMTP 비밀번호는 Supabase Dashboard에만 입력하며 저장소·브라우저에 넣지 않습니다. **Confirm signup** 메일 템플릿에 `{{ .Token }}`을 표시해야 이 앱의 코드 입력 화면으로 이메일을 확인할 수 있습니다. 저장소의 `supabase/templates/confirmation.html`을 복사하고 제목을 **Your Senmiva verification code**로 설정합니다. OTP 길이는 6자리, 만료는 3600초로 맞춥니다. `ConfirmationURL` 링크만 있는 기본 템플릿으로는 이 화면의 코드 확인을 완료할 수 없습니다. [공식 SMTP 안내](https://supabase.com/docs/guides/auth/auth-smtp), [메일 템플릿 안내](https://supabase.com/docs/guides/auth/auth-email-templates)

현재 페어링 화면은 CAPTCHA 토큰 제출을 지원하지 않습니다. 첫 검증은 CAPTCHA를 설정하지 않은 개발 전용 프로젝트에서 진행합니다. CAPTCHA가 필요한 운영 환경에는 해당 통합을 먼저 추가해야 합니다.

## 지금 PC에서 사용하기

이 PC에는 실제 로컬 Supabase와 첫 관리자·매장이 설정되어 있습니다. 관리자 이메일은 `local-owner@senmiva.test`이며, 생성된 비밀번호는 Git에서 제외된 `.local/supabase/<식별자>/owner.env`에 있습니다. `npm run supabase:local:prepare`를 다시 실행하면 파일 위치를 알려 주며, 기존 비밀번호를 바꾸지 않습니다. 이 계정은 로컬 개발 전용입니다.

```powershell
npm.cmd run supabase:start
npm.cmd run supabase:local:prepare
npm.cmd run dev:connected
```

Docker Desktop이 실행 중이어야 합니다. 시작 도구는 이 프로젝트의 데이터베이스, 인증/API, 개발용 메일함을 실행하고, API `127.0.0.1:15431`·DB `127.0.0.1:15432`·메일함 `127.0.0.1:15434`를 이 컴퓨터에서만 열도록 검증합니다. 기존 데이터 볼륨을 유지하며 초기화하지 않습니다. Windows 예약 포트와의 충돌 때문에 Supabase 기본 포트 대신 위 주소를 사용합니다. 최소 구성에는 Studio가 포함되지 않습니다.

**새 계정 만들기:** `/management/login`의 **Sign up** 또는 `/management/signup`에서 이메일과 12자 이상 비밀번호를 입력합니다. 기본 로컬 설정에서는 실제 이메일 주소로 발송되지 않고 [개발 메일함](http://127.0.0.1:15434)에 잡힙니다. 가입 화면에 **Local development email** 안내와 메일함 링크가 표시됩니다. [SMTP 설정](EMAIL-SETUP.md)을 완료하면 개인 이메일 수신함으로 발송됩니다. 해당 수신자의 **Your Senmiva verification code** 메일을 열어 6자리 코드를 가입 화면에 입력한 다음 회사명과 첫 매장명을 정합니다. 생성된 계정은 그 새 회사의 owner이며 기존 매장에는 접근할 수 없습니다. 새 매장은 USD 통화, 빈 상품 카탈로그, 명시적인 mock 성분 정책으로 시작합니다. 담당자 초대·기존 매장 합류는 이 가입 화면에서 지원하지 않습니다. 고객은 가입하지 않습니다.

개발 메일함에는 확인 코드가 있으므로 외부에 공개하거나 운영 환경에 배포하지 않습니다. SMTP 호스트 포트는 열지 않습니다. 로컬 Supabase를 종료하면 임시 메일함은 사라지며 Auth 계정과 회사 데이터는 데이터베이스 볼륨에 유지됩니다.

Auth config를 변경했다면 `npm run supabase:stop` 후 다시 시작합니다. 앱과 분석 서비스는 `dev:connected` 터미널에서 종료하고, DB는 별도로 `supabase:stop`으로 종료합니다. 클라우드 설정으로 바꾸기 전 로컬 `.env.local`과 `.env.supabase-admin.local`을 비공개 장소에 백업하고 클라우드 값으로 교체합니다. 앱 설정을 바꾼 뒤에는 서버를 재시작합니다.

개발 서버는 `.next-development`, 배포 빌드는 `.next`, 브라우저 테스트는 `.next-e2e`를 사용합니다. 실행 중인 개발 서버의 캐시를 빌드가 덮어써 화면 새로고침이 반복되지 않도록 분리했습니다. 재시작 시 오래된 HMR 상태가 복원되는 문제를 막기 위해 Turbopack 개발 디스크 캐시는 끄고 메모리 내 Fast Refresh는 유지합니다. 서버 실행 중에는 해당 서버의 출력 폴더를 삭제하거나 다른 프로세스와 같은 `NEXT_DIST_DIR`을 사용하지 않습니다.

## 비밀값을 로컬에 입력하기

저장소 루트의 `.env.local`에는 실행 설정만 둡니다. `.env.example`을 복사해서 실제 값으로 채웁니다. 아래의 `...`는 복사할 실제 값으로 바꾸는 자리입니다.

```dotenv
APP_MODE=supabase
NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
ANALYSIS_SERVICE_URL=http://127.0.0.1:8000
ANALYSIS_API_KEY=...
# ANALYSIS_DATABASE_URL은 --init이 제한된 전용 계정을 만들어 입력합니다.
NEXT_PUBLIC_HERO_VIDEO_URL=/media/senmiva-hero.mp4
```

`ANALYSIS_API_KEY`는 최소 32자의 무작위 비밀값이어야 합니다. 앱과 별도 FastAPI 서비스가 같은 값을 사용합니다. `npm run dev:connected`는 `.env.local`의 값을 두 프로세스에 전달하고 FastAPI를 loopback에서만 실행합니다. 배포할 때는 비밀값 관리 도구를 사용하고 분석 서비스를 사설 네트워크에 둡니다.

별도의 **`.env.supabase-admin.local`**에 일회성 설정용 관리자 연결과 회사 정보를 입력합니다. 이 파일은 앱이 읽는 설정 파일과 구분되며 Git에서 제외됩니다.

```dotenv
SUPABASE_ADMIN_DATABASE_URL="postgresql://..."
SUPABASE_ORGANIZATION_NAME="Senmiva"
SUPABASE_STORE_NAME="First Beauty Store"
SUPABASE_STORE_CURRENCY=USD
SUPABASE_OWNER_EMAIL="your-confirmed-admin@example.com"
# 필요 시 Dashboard Database 설정에서 받은 루트 인증서 경로:
# SUPABASE_DATABASE_CA_FILE="C:/private/supabase-root.crt"
```

현재 MVP의 가격·표시 기능은 **USD 매장만 지원**합니다. `SUPABASE_STORE_CURRENCY`는 USD로 두며 KRW/EUR 등은 초기화 전에 명확하게 거부합니다. 다중 통화는 별도 설계·구현 후 도입합니다.

관리자 연결은 데이터베이스 초기화에만 사용합니다. 실행 중인 앱은 별도의 `senmiva_analysis_login` 계정으로 두 분석 쓰기 함수만 호출합니다. `ANALYSIS_DATABASE_URL`, `ANALYSIS_API_KEY`, 관리자 연결 문자열에는 절대 `NEXT_PUBLIC_` 접두사를 붙이지 않습니다.

클라우드 연결은 TLS 인증서를 검증합니다. 인증서 오류가 나면 Dashboard의 Database 설정에서 루트 인증서를 받고 관리자 설정의 `SUPABASE_DATABASE_CA_FILE`과 앱 설정의 `ANALYSIS_DATABASE_CA_FILE`에 같은 파일 경로를 지정합니다. 인증서 검증을 끄는 방식으로 해결하지 않습니다. 로컬 Supabase의 loopback 연결에만 TLS를 생략합니다.

## 스키마와 계정 초기화

저장소 루트에서 실행합니다. 비밀번호나 연결 문자열을 명령 인수로 넘기지 않습니다.

```text
node scripts/supabase-setup.mjs --check
node scripts/supabase-setup.mjs --migrate
node scripts/supabase-setup.mjs --init --mock-policy
node scripts/supabase-setup.mjs --check
```

클라우드에서는 **`--migrate` 직후, 앱을 공개하기 전에 Authentication → Hooks → Before User Created**에서 PostgreSQL 함수를 선택하고 `public.senmiva_before_user_created`를 활성화합니다. Migration `202610100005`는 이메일 사업자 계정과 서버가 생성한 익명 기기를 허용하도록 기존 함수를 교체합니다. 권한은 가입 메타데이터에서 만들지 않습니다. 사업자가 이메일 확인을 완료하고 `create_owner_workspace`를 명시적으로 호출해야 서버가 새 회사·첫 매장·owner 권한을 원자적으로 생성합니다. 회사 ID나 기존 매장 ID를 이 함수에 넘길 수 없습니다. SQL hook의 실행 권한은 `supabase_auth_admin`에만 있으며 고객/직원/일반 API에서는 직접 호출할 수 없습니다. 로컬 Supabase는 저장소 config가 hook을 자동 등록합니다. SQL migration만 적용했다고 클라우드 Auth 설정·SMTP·메일 템플릿까지 바뀌지는 않습니다. [공식 Before User Created hook](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook)

- `--check`: 데이터베이스와 Auth 스키마, migration 상태, RLS, 확인된 owner, 매장, 공개 정책, 전용 writer 권한, 1분 정리 작업을 읽기 전용으로 확인합니다. 준비되지 않았으면 종료 코드 2, 연결/설정 오류면 1을 반환합니다. Auth provider 설정과 브라우저 로그인 성공까지 보증하는 검사는 아닙니다.
- `--migrate`: 저장소의 알려진 migration을 순서대로 한 트랜잭션에서 적용하고 Supabase CLI와 호환되는 migration 이력을 기록합니다. 임의의 다른 migration이나 이력 없는 기존 앱 테이블이 있으면 중단합니다. 적용된 migration은 수정하지 않고 새 파일을 추가합니다. 클라우드에서는 `seed.sql`을 실행하지 않습니다.
- `--init --mock-policy`: 회사, 첫 매장, 확인된 기존 관리자에 대한 owner 권한, 현재 mock용 성분 매칭 정책, 제한된 writer, 1분 정리 작업을 생성합니다. 기존 권한·매장 정보·공개 정책이 다르면 조용히 덮어쓰지 않고 중단합니다. 제품과 고객 데이터는 만들지 않습니다.
- 재실행은 같은 회사/매장을 검증하며 중복 생성하지 않습니다. DB 주소별로 `.local/supabase/<식별자>/`에 생성 ID와 writer 비밀값을 보관하므로, 로컬 검증 후 같은 checkout에서 클라우드를 설정할 수 있습니다. 같은 DB에는 처음 사용한 Direct/Session 연결 방식과 호스트를 계속 사용합니다.

전용 writer 비밀번호는 도구가 무작위로 생성합니다. 데이터베이스에는 SCRAM verifier를 전달하며, 평문 비밀번호나 URL을 출력하지 않습니다. 실제 전용 계정으로 로그인까지 성공하면 해당 URL을 `.env.local`에 저장합니다. 기존 writer가 있는데 비밀값을 잃은 경우 자동 비밀번호 변경 대신 복구/의도적 회전을 요구합니다. 설정 중 강제 종료하여 lock이 남은 경우 실행 중인 설정 프로세스가 없는지 확인한 후 **해당 DB의 `setup.lock` 파일 하나만** 제거하고 재실행합니다.

`--mock-policy`는 저장소의 19개 수동 mock 규칙을 명시적으로 선택합니다. 상품 성분의 존재를 매칭할 뿐, 농도·효능·알레르기 안전성을 입증하지 않습니다. 독립적으로 검토한 정책이 생기면 `supabase/mock-policy.json` 형식을 복사해 `reviewed:true`, `mockOnly:true`와 더 높은 `version`을 지정하고 다음처럼 실행합니다. 공개된 정책은 수정하지 않습니다.

```text
node scripts/supabase-setup.mjs --init --policy C:/private/reviewed-policy.json
```

클라우드 초기화 후 관리자에서 실제 제품을 draft로 등록하고 성분 검토 후 publish합니다. 매장별 가격·재고를 입력하고 표시를 켜야 추천 대상이 됩니다. 로컬 demo tenant의 허구 제품을 실제 매장에 자동 복사하지 않습니다.

## 로그인과 기기 페어링 확인

```text
npm run dev:connected
```

1. 컴퓨터에서 `http://127.0.0.1:3000/management/login`을 열고 확인된 관리자 이메일/비밀번호로 로그인합니다. 새 사업자는 **Sign up**에서 가입·이메일 코드 확인·회사와 첫 매장 설정을 완료합니다. 이메일 확인 후 설정 전에 나갔다면 다시 로그인하여 설정을 이어갈 수 있습니다.
2. **Devices → Pair a device**에서 기기 이름을 입력하고 페어링 코드를 발급합니다. 코드는 10분 동안 유효하며 한 번만 사용합니다.
3. 키오스크 브라우저의 `/kiosk/pair`에서 코드를 입력합니다. 서버가 별도의 익명 기기 인증을 만들고 매장에 연결합니다. 직원 로그인 쿠키와 기기 쿠키는 분리됩니다.
4. 키오스크에서 동의 → 질문 → mock 결과 → 해당 매장 제품 추천 → 완료를 확인합니다. 관리자에서 기기를 revoke하면 즉시 접근이 차단되고 진행 중 세션의 상세 정보가 삭제됩니다.
5. 브라우저 데이터를 지우거나 기기를 교체했다면 새 코드로 다시 페어링합니다. 활성 기기에 일괄 익명 사용자 삭제 작업을 적용하지 않습니다.

개발 모드에서는 설정된 앱과 프로토콜·포트가 같은 `localhost`와 `127.0.0.1`의 실제 동일 출처 요청을 허용합니다. 따라서 두 주소에서 가입할 수 있습니다. 쿠키는 호스트별로 저장되므로 가입·인증·회사 설정은 같은 주소의 탭에서 이어서 진행합니다. 기본 개발 주소는 `127.0.0.1:3000`입니다. 운영 모드는 설정된 공개 origin과 정확히 일치해야 하며 로컬 주소 예외가 없습니다. 실제 태블릿에서 접속할 때는 HTTPS 도메인, 인증서, 앱의 공개 origin, Auth URL 설정을 실제 배포 주소로 맞춥니다. `dev:connected`는 같은 PC에서 검증하기 위한 도구이며 매장 배포용 서버가 아닙니다.

## 검증 범위와 운영 확인

`npm run test:supabase`는 **로컬 Supabase**에 테스트용 tenant/사용자만 만들고 실제 브라우저 사업자 가입·개발 메일함의 코드 확인·회사 설정, 로그인, 페어링, mock 서비스, DB 저장, 기기 revoke, 권한 격리와 완료 후 삭제를 확인합니다. 확인되지 않은 계정과 조작된 메타데이터에 직원 권한이 생기지 않는지도 검사합니다. 생성한 테스트 회사/Auth 사용자/정확한 테스트 수신자의 메일만 정리하며 다른 메일은 지우지 않습니다. 테스트 관리자 Auth key는 `.env.supabase-admin.local`의 `SUPABASE_SERVICE_ROLE_KEY`에만 넣습니다. 정상 앱 실행/클라우드 초기화에는 이 key가 필요하지 않습니다. 이 fixture 테스트는 loopback 이외의 프로젝트를 거부합니다.

데이터베이스 pgTAP 검사는 로컬 Supabase에서 `npm run test:db`로 실행합니다. `npm run build` 후 `npm run test:supabase`는 실제 인증·API·DB·분석 서비스 연결을 검증하고 생성한 테스트 데이터만 정리합니다. `supabase db reset`은 로컬 데이터를 삭제하므로 클라우드 연결이나 필요한 데이터가 있는 환경에서 초기화 방법으로 쓰지 않습니다.

배포 전 `cron.job_run_details`에서 `senmiva-private-cleanup`의 실행 성공을 확인합니다. 완료/거절/revoke 시 상세 데이터는 즉시 지우고, 중단된 활성 세션은 15분 뒤 만료됩니다. 최소 동의/종료 메타데이터는 30일, audit 메타데이터는 90일 보관 후 정리하며 매장별 집계에는 고객 식별자를 넣지 않습니다. 실제 배포 지역의 동의문·보관 기간 검토와 대상 태블릿의 카메라/재접속 시험은 별도로 필요합니다.

비밀 파일은 Git에서 제외되지만 개발 PC 접근 권한과 백업 정책도 관리해야 합니다. 운영에서는 배포 환경의 secret store를 사용합니다. 키/비밀번호를 교체했다면 관련 서버를 다시 시작하고, 미사용 관리자 설정 파일은 안전하게 보관하거나 제거합니다.
