import CoreFoundation
import Foundation

/// JSON value kept after a line is parsed. Strings stay strings. Numbers stay numbers.
public enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(jsonObject any: Any) {
        if any is NSNull {
            self = .null
            return
        }
        if let text = any as? String {
            self = .string(text)
            return
        }
        if let number = any as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
                return
            }
            self = .number(number.doubleValue)
            return
        }
        if let list = any as? [Any] {
            self = .array(list.map(JSONValue.init(jsonObject:)))
            return
        }
        if let dict = any as? [String: Any] {
            var object: [String: JSONValue] = [:]
            for (key, value) in dict {
                object[key] = JSONValue(jsonObject: value)
            }
            self = .object(object)
            return
        }
        self = .null
    }

    public static func parse(data: Data) throws -> JSONValue {
        let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return JSONValue(jsonObject: object)
    }

    public var string: String? {
        if case let .string(text) = self { return text }
        return nil
    }

    public var bool: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }

    public var number: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    public var int: Int? {
        guard let number, number.isFinite, number.rounded() == number else { return nil }
        guard number <= Double(Int.max), number >= Double(Int.min) else { return nil }
        return Int(number)
    }

    public var object: [String: JSONValue]? {
        if case let .object(value) = self { return value }
        return nil
    }

    public var array: [JSONValue]? {
        if case let .array(value) = self { return value }
        return nil
    }

    public subscript(key: String) -> JSONValue? {
        object?[key]
    }

    /// Pretty JSON for the detail pane. Keys are sorted so the text is stable.
    public var display: String {
        render(indent: 0)
    }

    private func render(indent: Int) -> String {
        switch self {
        case .null:
            return "null"
        case let .bool(value):
            return value ? "true" : "false"
        case let .number(value):
            if value.rounded() == value, abs(value) < 1e15 {
                return String(Int(value))
            }
            return String(value)
        case let .string(text):
            let escaped = text
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            return "\"\(escaped)\""
        case let .array(items):
            if items.isEmpty { return "[]" }
            let pad = String(repeating: "  ", count: indent + 1)
            let body = items.map { pad + $0.render(indent: indent + 1) }.joined(separator: ",\n")
            return "[\n\(body)\n\(String(repeating: "  ", count: indent))]"
        case let .object(fields):
            if fields.isEmpty { return "{}" }
            let pad = String(repeating: "  ", count: indent + 1)
            let body = fields.keys.sorted().map { key in
                let value = fields[key] ?? .null
                return "\(pad)\"\(key)\": \(value.render(indent: indent + 1))"
            }.joined(separator: ",\n")
            return "{\n\(body)\n\(String(repeating: "  ", count: indent))}"
        }
    }
}
