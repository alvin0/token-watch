
Có nợ kiến trúc và nợ công nghệ đáng kể, nhưng chưa cần rewrite. Phần lõi parser/store khá chắc; nợ tập trung ở orchestration, ownership của DB, tính nhất quán số liệu UI, lifecycle async và quy trình release.
Cuộc rà soát dùng checklist dành cho VS Code extension, bao gồm activation/disposal, worker, webview/CSP, remote host, API compatibility, test và đóng gói. Mình kiểm tra worktree hiện tại, bao gồm các thay đổi chưa commit, và không sửa source.
Các khoản nợ ưu tiên
1. Cao — Worker có thể làm activation/query treo vô hạn.
   start() chỉ chờ ready hoặc Node Worker phát error, nhưng lỗi khởi tạo bên worker bị chuyển thành generic message nên promise không settle. Query/diagnostics cũng không có deadline và worker chết không được restart. Xem [IngestionCoordinator.ts](C:\\WorkHere\\Coding\\token-watch\\src\\host\\IngestionCoordinator.ts) và [ingestionWorker.ts](C:\\WorkHere\\Coding\\token-watch\\src\\worker\\ingestionWorker.ts).
   Nên thêm initError, diagnosticsError, timeout/cancellation, health state và restart/circuit breaker.
2. Cao — Global DB chưa có ownership rõ ràng trong mô hình nhiều cửa sổ VS Code.
   Mỗi cửa sổ tạo worker/watcher riêng nhưng cùng dùng globalStorageUri; pricing lại có thể lấy từ workspace hiện tại. Lock hiện tại ngăn overwrite mù nhưng worker thua sẽ reload và bỏ mutation trong RAM. Xem [extension.ts](C:\\WorkHere\\Coding\\token-watch\\src\\extension.ts), [config.ts](C:\\WorkHere\\Coding\\token-watch\\src\\host\\config.ts), [UsageStore.ts](C:\\WorkHere\\Coding\\token-watch\\src\\worker\\store\\UsageStore.ts).
   Cần chọn single-writer global service hoặc chuyển DB/config sang workspace scope nhất quán.
3. Cao — sql.js đang tạo write amplification lớn.
   FileWatcher phát empty scan mặc định khoảng mỗi 10 giây; hot catalog vẫn dẫn tới flush() dù không có dữ liệu thay đổi. Mỗi flush gọi db.export() và ghi lại toàn bộ DB. Xem [FileWatcher.ts](C:\\WorkHere\\Coding\\token-watch\\src\\host\\FileWatcher.ts), [ingestionWorker.ts](C:\\WorkHere\\Coding\\token-watch\\src\\worker\\ingestionWorker.ts), [UsageStore.ts](C:\\WorkHere\\Coding\\token-watch\\src\\worker\\store\\UsageStore.ts).
   Sửa ngắn hạn bằng dirty flag/no-op detection. Dài hạn cân nhắc SQLite persistent/WAL hoặc retention rõ ràng.
4. Cao — Một số số liệu UI đang sai ngữ nghĩa.
   - Cache-write bị cộng vào cache-hit trong [SummaryCard.tsx](C:\\WorkHere\\Coding\\token-watch\\src\\webview\\components\\SummaryCard.tsx) và [CurrentPeriodCard.tsx](C:\\WorkHere\\Coding\\token-watch\\src\\webview\\components\\CurrentPeriodCard.tsx).
   - Breakdown bỏ cache-write/reasoning nên không cộng lại đúng total.
   - “Top model” không gộp cùng model qua nhiều workspace; model cùng tên giữa Codex/Claude có thể bị nhập chung.
   - Phép tính tuần dùng 24h cố định và sai qua DST tại [periodData.ts](C:\\WorkHere\\Coding\\token-watch\\src\\webview\\lib\\periodData.ts).
   Nên tạo một deriveTokenMetrics() và một model summarizer dùng chung, kèm invariant tests.
5. Cao — Setting và warning đã khai báo nhưng pipeline chưa hoạt động.
   analytics.anomalyMultiplier và contextFillWarnPct có trong manifest nhưng không có consumer thực tế. Thay đổi source/path/debounce/max-line/backfill cũng không được áp dụng nếu không reload. Worker gửi warnings nhưng coordinator chỉ forward freshness; latestWarnings trong sidebar luôn mặc định và UI không render chúng. Xem [package.json](C:\\WorkHere\\Coding\\token-watch\\package.json), [workerProtocol.ts](C:\\WorkHere\\Coding\\token-watch\\src\\shared\\workerProtocol.ts), [IngestionCoordinator.ts](C:\\WorkHere\\Coding\\token-watch\\src\\host\\IngestionCoordinator.ts), [SidebarProvider.ts](C:\\WorkHere\\Coding\\token-watch\\src\\SidebarProvider.ts).
6. Cao — Ingestion chưa cô lập lỗi và chưa streaming thật sự.
   Một file biến mất/mất quyền có thể abort toàn scan, khiến các file phía sau không được ingest. Parser đọc theo dòng nhưng vẫn giữ toàn bộ turns/tools của một file trong arrays. Xem [ingest.ts](C:\\WorkHere\\Coding\\token-watch\\src\\worker\\ingest.ts), [codex.ts](C:\\WorkHere\\Coding\\token-watch\\src\\worker\\parsers\\codex.ts), [claude.ts](C:\\WorkHere\\Coding\\token-watch\\src\\worker\\parsers\\claude.ts).
   Nên quarantine/backoff theo file và commit theo batch có checkpoint.
7. Cao — Extension trực tiếp sửa credential của công cụ khác nhưng write không atomic.
   Codex và Claude overwrite credential file trực tiếp; Codex còn nuốt lỗi ghi. Network request không có deadline, trong khi endpoint/client ID/payload được hard-code theo contract dễ thay đổi. Xem [Codex provider](C:\\WorkHere\\Coding\\token-watch\\src\\provider\\codex\\index.ts) và [Claude provider](C:\\WorkHere\\Coding\\token-watch\\src\\provider\\claude\\index.ts).
   Cần atomic write, preserve permission, lock/file-identity check, timeout/AbortController và adapter/versioned validator cho từng provider.
8. Cao — VSIX đang đóng gói .codegraph ngoài ý muốn.
   .vscodeignore không loại .codegraph/** và scripts/**. VSIX hiện có database CodeGraph 6.7 MB thô, chiếm khoảng 54% file nén; còn ship benchmark script và pricing config mẫu. Xem [.vscodeignore](C:\\WorkHere\\Coding\\token-watch\\.vscodeignore).
   Đây nên là release blocker vì vừa bloat vừa có nguy cơ lộ metadata/path phát triển.
Nợ mức trung bình
- SidebarProvider và StatusBarController chứa hai bản gần như độc lập của logic fetch quota, cache, retry, plan và limit reset. Nên gom thành một UsageStatusService phát state cho cả hai consumer. Xem [SidebarProvider.ts](C:\\WorkHere\\Coding\\token-watch\\src\\SidebarProvider.ts) và [StatusBarController.ts](C:\\WorkHere\\Coding\\token-watch\\src\\host\\StatusBarController.ts).
- Webview store là singleton import-time, không timeout save/query, không persist bằng getState/setState, và daily drill-down có thể hiển thị dữ liệu cũ trong lúc request mới pending. Xem [store.ts](C:\\WorkHere\\Coding\\token-watch\\src\\webview\\store.ts).
- Secondary currency được gửi tới store nhưng phần lớn card vẫn gọi formatter chỉ với USD. Nhãn ngày/tháng còn hard-code en-US.
- Bốn modal chưa có focus trap/restore focus; chart và segmented controls thiếu selected/accessibility semantics.
- Manifest hứa hỗ trợ VS Code ^1.90, nhưng lockfile dùng @types/vscode 1.120 và test chỉ chạy stable mới nhất. Bundle cũng không đặt target Node/Chromium tương ứng minimum. Xem [package.json](C:\\WorkHere\\Coding\\token-watch\\package.json), [esbuild.js](C:\\WorkHere\\Coding\\token-watch\\esbuild.js), [.vscode-test.mjs](C:\\WorkHere\\Coding\\token-watch\\.vscode-test.mjs).
- Không có CI, OS matrix hoặc release gate. Pure/property tests lại chạy bên trong Extension Host, làm host nhiều lần bị báo unresponsive.
- Một số integration test có tên mạnh hơn assertion thực tế: “config without restart”, CSP và status bar đều chỉ kiểm proxy/manifest, chưa kiểm hành vi. Xem [extension.test.ts](C:\\WorkHere\\Coding\\token-watch\\src\\test\\integration\\extension.test.ts).
Kết quả kiểm chứng
- TypeScript: pass.
- ESLint: pass.
- Compile tests: pass.
- Full test: 200 pass, 2 fail.
  - Lỗi DST trong pRange là lỗi sản phẩm; đã tái hiện ở New York, Los Angeles và Berlin.
  - Lỗi Claude credentials path là lỗi test giả định dấu / trên Windows.
- npm audit --omit=dev: 0 runtime vulnerability.
- Toàn bộ dependency tree: 10 high + 3 moderate, đều thuộc dev tooling.
- Các major version như React 19, Recharts 3, Tailwind 4 không cần nâng ồ ạt; nên ưu tiên PostCSS, esbuild và ESLint trước.
Thứ tự xử lý đề xuất
1. Chặn release: bỏ .codegraph khỏi VSIX, sửa hai test đỏ, chuẩn hóa token/model calculations.
2. Ổn định runtime: worker handshake/deadline, per-file isolation, network timeout và atomic credential writes.
3. Chốt kiến trúc DB: single writer, dirty flush, scope global/workspace.
4. Hoàn thiện config/warning pipeline.
5. Tách unit tests khỏi Extension Host, thêm CI Windows/macOS/Linux và test VS Code minimum + stable.
6. Sau đó mới xử lý accessibility, currency/i18n, state persistence và nâng major dependencies.
Goal condition is limited to 4000 characters (got 7995)

