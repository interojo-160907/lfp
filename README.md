# 리드지 수급관리

APS, ERP OpenAPI의 최신 데이터를 GitHub Actions가 수집하고 정적 대시보드로 배포하는 프로젝트입니다.

## 운영 구조

1. GitHub Actions가 OpenAPI를 호출합니다.
2. 필요한 결과만 web/data/*.json에 저장합니다.
3. 실제 데이터가 바뀐 경우에만 커밋합니다.
4. GitHub Pages가 web/을 배포합니다.

DMZ 서버, PostgreSQL, SQL 스키마는 사용하지 않습니다. API 인증정보는 저장소 파일에 넣지 않고 GitHub Actions Secrets로만 관리합니다.

## 수집 정책

- APS 감시: Cloudflare Worker가 주말을 포함해 365일 24시간, 1분 간격으로 원본 버전을 확인
- APS 원본 갱신 시: APS, 재고, 구매·입고, BOM 전체 최신화
- 마지막 정규수집 후 16시간 동안 APS 변화가 없으면 재고, 구매·입고, BOM 안전수집
- APS 확인 API가 실패해도 16시간 안전수집 시점에는 APS 외 채널을 최신화
- 생산실적: Cloudflare Worker가 매일 08:00(Asia/Seoul)에 전일까지 최근 7일치를 수집
- 수동 수집 범위: 전체, APS, 재고, 구매·입고, BOM, 생산실적
- 수동수집은 자동 정규수집의 16시간 기준과 APS 처리 버전을 변경하지 않음
- 데이터 보관: 대시보드용 최신 JSON만 유지
- 수집 상태 이력: 최근 48시간만 유지
- 빈 커밋: 생성하지 않음
- 업로드 원본 Excel: 저장하지 않고 필요한 관리 데이터만 변환

### API 선필터 기준

- 재고·검사대기: L관/A관/C관/S관, BS코드, 품명 `리드지`
- 구매·입고: 최근 2개월, BS코드, 미발주 또는 미납 행
- APS: Backward 공정 55, P코드; 해외/PB/국내/안전재고 전량을 BS 리드지로 환산
- 생산실적: 전일까지 최근 7일을 일자별로 완전 수집한 뒤 공정 55 P코드만 환산
- BOM: ERP API가 접두어 복합필터를 지원하지 않아 전체 정전개를 한 번 받은 뒤 활성 P코드의 1차 BS 리드지만 저장

## GitHub Actions

- Collect dashboard data: 예약 수집 및 수동 최신화
- Deploy GitHub Pages: web/ 정적 대시보드 배포

API 주소와 인증값은 .env.example 및 수집 워크플로에 정의된 이름으로 GitHub 저장소의 Settings > Secrets and variables > Actions에 등록합니다.

## 로컬 실행

python scripts/serve_dashboard.py --port 8878

로컬 서버는 개발 확인용일 뿐 운영 대시보드 수집에는 사용하지 않습니다. 운영 수동수집은 GitHub Pages → Cloudflare Worker → GitHub Actions → ERP API 경로로 실행됩니다.

## 수급 갱신 일관성 (2026-10-08)

재고·APS·구매 수동수집과 APS 변경 자동수집은 BOM·재고/검사대기·구매/입고를 함께 갱신합니다. 모든 요청 채널의 조회와 검증을 완료한 뒤 결과 파일을 기록합니다. 원천 조회 실패 시 중간 결과를 기록하거나 성공 상태를 게시하지 않습니다.

발주대기는 기존 승인(Y)·완료 의뢰의 미발주수량 기준을 유지합니다. 기안(G)·의뢰 수량은 `pendingApprovalQty`로 별도 보존하고 상세 비고에 표시하며 확보수량에 더하지 않습니다. 제외된 상태 및 미연결 품목은 `excludedRows`에서 추적합니다. 구매에만 있는 품목도 상세 및 대시보드의 행 구성에 포함합니다. 최근 2개월 조회 정책은 유지합니다.

APS 산출은 `/api/aps-backward-plan?oper=55&limit=0`의 `backward_qty`만 사용합니다. Forward/PLAN/미계획수량으로 대체하지 않습니다. 상세 P코드에서 기본 품번을 추출해 실제 BOM 소요량을 곱하며, 수요 ID의 수주번호·순번을 유지합니다.
