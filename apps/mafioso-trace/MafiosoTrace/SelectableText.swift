import AppKit
import SwiftUI

/// Selectable monospaced text that does not come up highlighted.
struct SelectableText: NSViewRepresentable {
    var text: String

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        configure(field)
        return field
    }

    func updateNSView(_ field: NSTextField, context: Context) {
        if field.stringValue != text {
            field.stringValue = text
            field.currentEditor()?.selectedRange = NSRange(location: 0, length: 0)
        }
        configure(field)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView field: NSTextField, context: Context) -> CGSize? {
        let width = proposal.width ?? 480
        guard width.isFinite, width > 1 else { return nil }
        field.preferredMaxLayoutWidth = width
        let height = field.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: width, height: 10_000)).height ?? 18
        return CGSize(width: width, height: max(height, 18))
    }

    private func configure(_ field: NSTextField) {
        field.isEditable = false
        field.isSelectable = true
        field.isBezeled = false
        field.drawsBackground = false
        field.backgroundColor = .clear
        field.textColor = .labelColor
        field.font = .monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 0
        field.cell?.wraps = true
        field.cell?.isScrollable = false
        field.alignment = .left
    }
}
