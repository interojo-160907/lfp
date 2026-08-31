# 리드지 수급관리

APS, ERP OpenAPI의 최신 데이터를 GitHub Actions가 수집하고 정적 대시보드로 배포하는 프로젝트입니다.

## 운영 구조

1. GitHub Actions가 OpenAPI를 호출합니다.
2. 필요한 결과만 web/data/*.json에 저장합니다.
3. 실제 데이터가 바뀐 경우에만 커밋합니다.
4. GitHub Pages가 web/을 배포합니다.

DMZ 서버, PostgreSQL, SQL 스키마는 사용하지 않습니다. API 인증정보는 저장소 파일에 넣지 않고 GitHub Actions Secrets로만 관리합니다.

## 수집 정책

- APS 감시: 주말을 포함해 365일 24시간, 5분 간격
- APS 원본 갱신 시: APS, 재고, 구매·입고, BOM 전체 최신화
- 마지막 정규수집 후 16시간 동안 APS 변화가 없으면 재고, 구매·입고, BOM 안전수집
- APS 확인 API가 실패해도 16시간 안전수집 시점에는 APS 외 채널을 최신화
- 수동 수집 범위: 전체, APS, 재고, 구매·입고, BOM
- 수동수집은 자동 정규수집의 16시간 기준과 APS 처리 버전을 변경하지 않음
- 데이터 보관: 대시보드용 최신 JSON만 유지
- 수집 상태 이력: 최근 48시간만 유지
- 빈 커밋: 생성하지 않음
- 업로드 원본 Excel: 저장하지 않고 필요한 관리 데이터만 변환

## GitHub Actions

- Collect dashboard data: 예약 수집 및 수동 최신화
- Deploy GitHub Pages: web/ 정적 대시보드 배포

API 주소와 인증값은 .env.example 및 수집 워크플로에 정의된 이름으로 GitHub 저장소의 Settings > Secrets and variables > Actions에 등록합니다.

## 로컬 실행

python scripts/serve_dashboard.py --port 8878

로컬 새로고침 요청은 scripts/monitor_collections.py를 거쳐 API 전용 수집기를 실행합니다.
