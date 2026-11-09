# Lồng Tiếng Việt cho YouTube (v1.1.0)

Tiện ích trình duyệt (Edge / Chrome / Cốc Cốc): mở video YouTube nước ngoài là tự động lồng tiếng Việt,
âm thanh gốc được giảm nhỏ mượt mà khi giọng Việt đang đọc.

## Cài đặt (1 phút)
1. Mở `edge://extensions` (hoặc `chrome://extensions`).
2. Bật **Developer mode / Chế độ nhà phát triển**.
3. Bấm **Load unpacked / Tải tiện ích đã giải nén** → chọn thư mục này.
4. Mở video YouTube bất kỳ → thưởng thức lồng tiếng Việt tức thì!

## Các tính năng nổi bật (v1.1.0)
- **Tương thích hoàn hảo 100% trên cả Microsoft Edge & Chrome**: Tinh chỉnh kiến trúc AudioTTS background, loại bỏ hoàn toàn hiện tượng kẹt/đơ giọng đọc trên Edge.
- **Tự động nhận diện video tiếng Việt (4 lớp)**: Tự động phát hiện video gốc tiếng Việt (qua ngôn ngữ audio, nhận diện giọng nói ASR, track phụ đề và tiêu đề tiếng Việt) để **tự động bỏ qua**, tránh phiền phức phải tắt thủ công.
- **Giọng đọc tự nhiên Microsoft Azure Neural TTS (Hoài My & Nam Minh)**:
  - Tích hợp điều chỉnh tốc độ đọc và **Tone giọng (Pitch)** trực tiếp qua SSML:
    - **Trầm ấm (-8Hz)**: Thích hợp cho phim tài liệu, tin tức, podcast.
    - **Chuẩn (0Hz)**: Tự nhiên, rõ ràng.
    - **Thanh thoát (+5Hz)**: Tươi sáng, trẻ trung.
  - Tốc độ đọc nhanh/chậm được AI tổng hợp tự nhiên, không bị méo tiếng (không bị hiệu ứng sóc chuột).
- **Menu cài đặt nhanh (Quick Control Popover) trên player**: Rê chuột hoặc bấm biểu tượng bánh răng **⚙** cạnh nút **VI** trên thanh trình phát để chỉnh nhanh âm lượng, đổi giọng, đổi pitch, bật/tắt phụ đề mà không cần rời chế độ xem toàn màn hình (Fullscreen).
- **Tự động đồng bộ tốc độ phát video (Auto Speed Sync)**: Xem video ở tốc độ 1.25x, 1.5x, 2x thì giọng đọc tự động tăng tốc tương ứng, không bao giờ bị trễ nhịp.
- **Giảm âm gốc siêu mượt (Smooth Audio Ducking)**: Âm thanh video gốc hạ xuống êm dịu khi có giọng nói tiếng Việt và nổi lên lại từ từ sau khi dứt câu.
- **Bộ lọc âm thanh & nhạc thông minh**: Tự động bỏ qua các đoạn phụ đề chỉ mô tả âm thanh như `[Music]`, `[Applause]`, `[Laughter]`, `♪`, `♫` để bạn thưởng thức trọn vẹn nhạc nền của video.
- **Hỗ trợ cả YouTube Shorts**: Tự động lồng tiếng cho cả trang video thường (`/watch`) và YouTube Shorts (`/shorts/`).

## Phím tắt & Thao tác nhanh
- **Alt + V** hoặc nút **VI** trên thanh trình phát: Bật / Tắt lồng tiếng.
- Bấm biểu tượng **⚙** cạnh nút **VI**: Mở nhanh bảng cài đặt âm lượng và giọng đọc.

## Giới hạn
- Video hoàn toàn không có phụ đề nào (kể cả phụ đề tự động của YouTube) thì chưa lồng tiếng được.
