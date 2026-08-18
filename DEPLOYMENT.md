# Hướng dẫn triển khai PIXEL RUSH trên EdgeOne Pages

## Tổng quan
Dự án đã được chuyển đổi để hỗ trợ triển khai trên EdgeOne Cloud Functions với WebSocket.

## Cấu trúc mới
```
/workspace
├── cloud-functions/
│   └── ws/
│       └── [[default]].js    # Express server với WebSocket relay
├── dist/                      # Frontend build (sau khi npm run build)
├── src/                       # Source code frontend React
└── package.json
```

## Các bước triển khai

### 1. Build frontend
```bash
npm run build
```
Lệnh này tạo ra thư mục `dist/` chứa các file tĩnh của frontend.

### 2. Deploy lên EdgeOne Pages

#### Cách 1: Sử dụng EdgeOne CLI (nếu có)
```bash
edgeone deploy
```

#### Cách 2: Upload qua Console
1. Truy cập [EdgeOne Console](https://console.tencentcloud.com/edgeone)
2. Chọn site của bạn
3. Vào **Site Acceleration** > **Cloud Functions**
4. Upload thư mục `cloud-functions/ws/` 
5. Upload nội dung thư mục `dist/` vào root của site

### 3. Cấu hình WebSocket trong Rule Engine

1. Vào **Rule Engine** trong EdgeOne Console
2. Tạo rule mới:
   - **Match Type**: Path
   - **Pattern**: `/ws*`
   - **Action**: WebSocket
   - **Status**: Enable
   - **Maximum connection timeout**: 300 seconds (max)

3. Lưu và publish rule

### 4. Cấu hình thêm (tùy chọn)

#### CORS cho API
Đã được cấu hình sẵn trong code với header:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Upgrade`

#### Environment Variables
Nếu cần thay đổi PORT hoặc MAX_PLAYERS:
```javascript
const PORT = process.env.PORT || 8000;
const MAX_PLAYERS = 2;
```

## Endpoints sau khi deploy

- **Frontend**: `https://your-domain.edgeone.app/`
- **WebSocket**: `wss://your-domain.edgeone.app/ws?room=ROOM_CODE`
- **Rooms API**: `https://your-domain.edgeone.app/rooms`
- **Status**: `https://your-domain.edgeone.app/status`

## Kiểm tra kết nối

Sử dụng script test có sẵn:
```bash
npm run test-ws -- wss://your-domain.edgeone.app/ws?room=test
```

Hoặc mở trình duyệt và truy cập URL frontend, sau đó tạo/join phòng chơi.

## Lưu ý quan trọng

1. **Thời gian kết nối WebSocket**: Tối đa 300 giây (5 phút) theo giới hạn của EdgeOne
2. **Build frontend trước khi deploy**: Luôn chạy `npm run build` trước khi upload
3. **WebSocket path**: Phải cấu hình Rule Engine cho path `/ws*` để kích hoạt WebSocket support
4. **HTTPS/WSS**: Trên production, sử dụng `wss://` thay vì `ws://`

## Khắc phục sự cố

### WebSocket không kết nối được
- Kiểm tra Rule Engine đã được cấu hình đúng cho path `/ws*` chưa
- Đảm bảo frontend đang sử dụng đúng protocol (wss:// cho HTTPS)

### 404 khi truy cập frontend
- Đảm bảo đã build và upload thư mục `dist/`
- Kiểm tra file `index.html` có trong thư mục gốc của site

### Room đầy ngay lập tức
- Kiểm tra biến `MAX_PLAYERS` trong code (mặc định là 2)
- Xóa cache hoặc restart Cloud Function nếu cần
