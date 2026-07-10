// pet-bubble.swift — 펫 말풍선을 메뉴바 아래 실제 떠있는 창으로 보여주는 헬퍼
// 사용법: pet-bubble "<message>" [durationSeconds=4] [xOffsetFromRight=250]
// 의존성 없음(AppKit만). Dock 아이콘 없음(.accessory), 포커스 강탈 없음(non-activating panel).
// 빌드: xcrun swiftc -O pet-bubble.swift -o pet-bubble

import AppKit
import ApplicationServices

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

// ── AX 기반 펫 위치 탐지 ──
// SwiftBar의 메뉴바 아이템 중 타이틀이 없고 너비가 22~42pt인 것(펫 아이콘, 보통 34pt)을 찾아
// 그 중심 X좌표를 반환한다. 신뢰 안 됨/SwiftBar 없음/일치 아이템 없음 등 어느 단계에서든
// 실패하면 nil을 반환하고, 호출부는 기존 고정 오프셋(xOffsetFromRight)으로 조용히 폴백한다.
func axAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
  var value: AnyObject?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
    return nil
  }
  return value
}

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
  guard let raw = axAttribute(element, attribute) else { return nil }
  var point = CGPoint.zero
  guard AXValueGetValue(raw as! AXValue, .cgPoint, &point) else { return nil }
  return point
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
  guard let raw = axAttribute(element, attribute) else { return nil }
  var size = CGSize.zero
  guard AXValueGetValue(raw as! AXValue, .cgSize, &size) else { return nil }
  return size
}

func findPetMenuBarItemCenterX() -> CGFloat? {
  // 백그라운드 헬퍼라 권한 프롬프트는 절대 띄우지 않음 — prompt 옵션 없는 AXIsProcessTrusted()만 사용
  guard AXIsProcessTrusted() else { return nil }

  let apps = NSWorkspace.shared.runningApplications
  guard
    let swiftBar = apps.first(where: { $0.bundleIdentifier == "com.ameba.SwiftBar" })
      ?? apps.first(where: { $0.localizedName == "SwiftBar" })
  else {
    return nil
  }

  let appElement = AXUIElementCreateApplication(swiftBar.processIdentifier)
  guard let children = axAttribute(appElement, kAXChildrenAttribute as String) as? [AXUIElement] else {
    return nil
  }
  let menuBars = children.filter {
    (axAttribute($0, kAXRoleAttribute as String) as? String) == (kAXMenuBarRole as String)
  }
  guard !menuBars.isEmpty else { return nil }

  // 후보: 타이틀 없음 + 너비 22...42pt. 그중 34pt(펫 아이콘 실측 폭)에 가장 가까운 것을 선택.
  var best: (x: CGFloat, width: CGFloat)?
  for menuBar in menuBars {
    guard let items = axAttribute(menuBar, kAXChildrenAttribute as String) as? [AXUIElement] else { continue }
    for item in items {
      guard (axAttribute(item, kAXRoleAttribute as String) as? String) == (kAXMenuBarItemRole as String) else {
        continue
      }
      let title = (axAttribute(item, kAXTitleAttribute as String) as? String) ?? ""
      guard title.isEmpty else { continue }
      guard let size = axSize(item, kAXSizeAttribute as String), size.width >= 22, size.width <= 42 else {
        continue
      }
      guard let pos = axPoint(item, kAXPositionAttribute as String) else { continue }
      if best == nil || abs(size.width - 34) < abs(best!.width - 34) {
        best = (pos.x + size.width / 2, size.width)
      }
    }
  }
  return best?.x
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
    let x: CGFloat
    if let petCenterX = findPetMenuBarItemCenterX() {
      // 꼬리는 말풍선 폭의 75% 지점에 있으므로, 그 지점이 펫 중심(petCenterX)에 오도록 배치
      let raw = petCenterX - 0.75 * totalWidth
      x = min(max(raw, visibleFrame.minX + 8), visibleFrame.maxX - totalWidth - 8)
    } else {
      x = screenFrame.maxX - totalWidth - xOffsetFromRight
    }
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
