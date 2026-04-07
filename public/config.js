// Vercel(정적) 배포 시 빌드/런타임 환경변수를 직접 주입하기 어렵기 때문에,
// 여기서 프론트가 붙을 Socket.io 서버 URL을 한 곳에서 관리한다.
// 필요하면 Vercel에서 이 파일만 수정해도 된다.
window.MATHFISH_SERVER_URL = "https://mathfish.onrender.com";

