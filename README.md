# MathFish.io (MVP)

초등 4학년 **곱셈/나눗셈** 학습을 위한 실시간 멀티플레이어 .io 스타일 웹 게임 MVP입니다.  
Node.js + Express + Socket.io 서버가 상태를 동기화하고, 클라이언트는 Phaser 3로 렌더링합니다.

## 실행 방법 (로컬)

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:3000` 접속 후, 탭을 여러 개 열면 멀티플레이가 됩니다.

## 배포 (Render.com)

- **권장 방식**: GitHub에 푸시 → Render에서 “New Web Service”로 연결
- 이 프로젝트는 `render.yaml`이 포함되어 있어, Render가 자동으로 설정을 읽을 수 있습니다.
  - **Build Command**: `npm install`
  - **Start Command**: `npm start`
  - **Health Check**: `/healthz`

## MVP에 포함된 것

- 먹이 획득 → 문제 팝업(입력 중 보호막) → 정답/오답 처리
- 오답 패턴(간단 버전)
  - 곱셈 0 개수 실수 감지 → 힌트 + 보충 먹이 스폰
  - 나눗셈(10의 배수)에서 구구단 연계 힌트
- 3연속 정답 시 심화 먹이(황금 진주) 스폰
- PvP: 큰 물고기가 작은 물고기 잡아먹기(보호막 중 제외) + 즉시 리스폰
- 랭킹 보드
- 5분마다 거북이 문장제 이벤트(최초 정답자 보상)

## 코드 파일 길이 정책

요구사항에 맞춰 **모든 페이지/파일이 1000줄을 넘지 않도록** 모듈을 분리했습니다.

