// pet-bubble.swift — 펫 말풍선을 메뉴바 아래 실제 떠있는 창으로 보여주는 헬퍼
// 사용법: pet-bubble "<message>" [durationSeconds=4] [xOffsetFromRight=250]
// 의존성 없음(AppKit만). Dock 아이콘 없음(.accessory), 포커스 강탈 없음(non-activating panel).
// 빌드: xcrun swiftc -O pet-bubble.swift -o pet-bubble

import AppKit

// ── 인자 파싱 ──
let args = CommandLine.arguments
guard args.count > 1, !args[1].isEmpty else {
  FileHandle.standardError.write("사용법: pet-bubble \"<message>\" [durationSeconds=4] [xOffsetFromRight=250]\n".data(using: .utf8)!)
  exit(1)
}
let message = args[1]
let duration: Double = args.count > 2 ? (Double(args[2]) ?? 4) : 4
let xOffsetFromRight: CGFloat = args.count > 3 ? (CGFloat(Double(args[3]) ?? 250)) : 250

// ── 말풍선 뷰: 둥근 사각형 + 위쪽을 향한 꼬리(tail) ──
final class BubbleView: NSView {
  let text: String
  let textColor: NSColor
  let bubbleColor: NSColor
  let borderColor: NSColor
  static let tailHeight: CGFloat = 8
  static let tailWidth: CGFloat = 14
  static let cornerRadius: CGFloat = 10
  static let paddingX: CGFloat = 12
  static let paddingY: CGFloat = 9
  static let maxTextWidth: CGFloat = 340

  init(text: String, dark: Bool) {
    self.text = text
    if dark {
      self.bubbleColor = NSColor(white: 0.16, alpha: 0.97)
      self.textColor = .white
      self.borderColor = NSColor(white: 1.0, alpha: 0.12)
    } else {
      self.bubbleColor = NSColor(white: 1.0, alpha: 0.97)
      self.textColor = NSColor(white: 0.1, alpha: 1.0)
      self.borderColor = NSColor(white: 0.0, alpha: 0.12)
    }
    super.init(frame: .zero)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func attributedString(for text: String) -> NSAttributedString {
    let font = NSFont.systemFont(ofSize: 13)
    return NSAttributedString(string: text, attributes: [.font: font])
  }

  // 말풍선(꼬리 제외) 크기를 텍스트에 맞춰 계산
  static func bubbleSize(for text: String) -> NSSize {
    let attr = attributedString(for: text)
    let bounding = attr.boundingRect(
      with: NSSize(width: maxTextWidth, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading]
    )
    let w = ceil(bounding.width) + paddingX * 2
    let h = ceil(bounding.height) + paddingY * 2
    return NSSize(width: w, height: h)
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let bubbleRect = NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height - Self.tailHeight)

    // 말풍선 본체 (둥근 사각형)
    let path = NSBezierPath(roundedRect: bubbleRect, xRadius: Self.cornerRadius, yRadius: Self.cornerRadius)

    // 꼬리: 말풍선 폭의 75% 지점에서 위로 뾰족하게 (메뉴바를 향함)
    let tailCenterX = bubbleRect.width * 0.75
    let tailTop = NSPoint(x: tailCenterX, y: bubbleRect.maxY + Self.tailHeight)
    let tailLeft = NSPoint(x: tailCenterX - Self.tailWidth / 2, y: bubbleRect.maxY)
    let tailRight = NSPoint(x: tailCenterX + Self.tailWidth / 2, y: bubbleRect.maxY)
    path.move(to: tailLeft)
    path.line(to: tailTop)
    path.line(to: tailRight)
    path.close()

    bubbleColor.setFill()
    path.fill()

    // 1px 테두리
    borderColor.setStroke()
    path.lineWidth = 1
    path.stroke()

    ctx.saveGState()
    let textRect = bubbleRect.insetBy(dx: Self.paddingX, dy: Self.paddingY)
    let attr = NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: textColor])
    attr.draw(with: textRect, options: [.usesLineFragmentOrigin, .usesFontLeading])
    ctx.restoreGState()
  }
}

// ── 앱 델리게이트: 패널 생성 + 페이드 인/아웃 애니메이션 ──
final class AppDelegate: NSObject, NSApplicationDelegate {
  var panel: NSPanel?

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard let screen = NSScreen.main else {
      NSApp.terminate(nil)
      return
    }

    let dark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    let bubbleSize = BubbleView.bubbleSize(for: message)
    let totalHeight = bubbleSize.height + BubbleView.tailHeight
    let totalWidth = bubbleSize.width

    let screenFrame = screen.frame
    let visibleFrame = screen.visibleFrame
    let x = screenFrame.maxX - totalWidth - xOffsetFromRight
    // 메뉴바 바로 아래: visibleFrame의 위쪽 경계가 메뉴바 하단
    let y = visibleFrame.maxY - totalHeight - 2

    let panelRect = NSRect(x: x, y: y, width: totalWidth, height: totalHeight)
    let p = NSPanel(
      contentRect: panelRect,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    p.level = .statusBar
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.ignoresMouseEvents = true
    p.collectionBehavior = [.canJoinAllSpaces, .transient]
    p.isReleasedWhenClosed = false

    let view = BubbleView(text: message, dark: dark)
    view.frame = NSRect(x: 0, y: 0, width: totalWidth, height: totalHeight)
    p.contentView = view

    p.alphaValue = 0
    p.orderFrontRegardless()
    self.panel = p

    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.18
      p.animator().alphaValue = 1
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = 0.3
        p.animator().alphaValue = 0
      }, completionHandler: {
        NSApp.terminate(nil)
      })
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
