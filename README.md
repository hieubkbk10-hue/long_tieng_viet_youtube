# Lồng Tiếng Việt cho YouTube

Tiện ích trình duyệt (Edge / Chrome): mở video YouTube nước ngoài là tự lồng tiếng Việt,
âm thanh gốc được giảm nhỏ khi giọng Việt đang đọc.

## Cài đặt (1 phút)
1. Mở `edge://extensions` (hoặc `chrome://extensions`).
2. Bật **Developer mode / Chế độ nhà phát triển**.
3. Bấm **Load unpacked / Tải tiện ích đã giải nén** → chọn thư mục `long-tieng-viet`.
4. Mở video YouTube bất kỳ → góc trên trái hiện "Đang dịch…" rồi bắt đầu lồng tiếng.

## Dùng
- Nút **VI** trên thanh trình phát hoặc **Alt+V** để bật/tắt.
- Bấm biểu tượng tiện ích để chọn giọng, tốc độ, mức âm gốc, bật phụ đề Việt.

## Cách hoạt động
Phụ đề của video (kể cả phụ đề tự động) → gộp thành câu → Google Dịch sang tiếng Việt
→ đọc bằng giọng Việt, khớp thời gian với video (câu dài sẽ đọc nhanh hơn một chút).
- **Giọng tự nhiên (Natural) trên cả Chrome & Edge**: Tiện ích tích hợp trực tiếp giọng đọc tự nhiên cao cấp của Microsoft Azure (**Hoài My** - Nữ và **Nam Minh** - Nam). Dù bạn dùng Google Chrome, Edge hay Cốc Cốc, bạn đều có giọng đọc truyền cảm, tự nhiên như người thật mà không cần chuyển sang Edge.
- **Giọng dự phòng**: Nếu mạng gián đoạn, tiện ích tự động chuyển sang Google Dịch để không làm gián đoạn việc xem video.
- **Giọng hệ thống Windows**: Tự động nhận diện nếu máy tính có cài giọng đọc tiếng Việt của hệ thống.
- Không cần API key, không tốn phí. Bản dịch được lưu lại (40 video gần nhất) nên xem lại sẽ không phải dịch lại.

## Giới hạn
- Video **không có phụ đề nào** (kể cả tự động) thì chưa lồng tiếng được.
- Chỉ hỗ trợ trang xem video thường (`/watch`), chưa hỗ trợ Shorts.
