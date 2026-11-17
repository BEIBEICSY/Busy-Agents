import Foundation

@main
struct NodeLookupCheck {
    static func main() {
        var failed = 0
        func expect(_ name: String, _ actual: String?, _ expected: String?) {
            if actual == expected {
                print("ok \(name)")
            } else {
                failed += 1
                fputs("fail \(name): \(actual ?? "nil") != \(expected ?? "nil")\n", stderr)
            }
        }

        let home = "/Users/someone"
        let fnm = "\(home)/Library/Application Support/fnm"
        let fnmDefault = "\(fnm)/aliases/default/bin/node"
        let fnm18 = "\(fnm)/node-versions/v18.20.0/installation/bin/node"
        let fnm22 = "\(fnm)/node-versions/v22.22.3/installation/bin/node"
        let nvm22 = "\(home)/.nvm/versions/node/v22.22.3/bin/node"
        let asdf = "\(home)/.asdf/shims/node"

        func lookup(
            executables: Set<String>,
            directories: [String: [String]] = [:],
            texts: [String: String] = [:],
            majors: [String: Int] = [:],
            shell: [String] = [],
            environment: [String: String] = [:],
            bundled: String? = nil
        ) -> String? {
            NodeLookup.locate(
                home: home,
                environment: environment,
                bundledNode: bundled,
                isExecutable: { executables.contains($0) },
                nodeMajor: { majors[$0] ?? (executables.contains($0) ? 22 : nil) },
                directoryEntries: { directories[$0] ?? [] },
                readText: { texts[$0] },
                resolveShell: { arguments in
                    arguments == ["-lc", "command -v node"] ? shell.first : shell.dropFirst().first
                }
            )
        }

        expect("fnm 默认版本", lookup(
            executables: [fnmDefault],
            directories: ["\(fnm)/node-versions": ["v22.22.3"]]
        ), fnmDefault)

        expect("fnm 没有默认别名时用最高版本", lookup(
            executables: [fnm18, fnm22],
            directories: ["\(fnm)/node-versions": ["v18.20.0", "v22.22.3"]],
            majors: [fnm18: 18, fnm22: 22]
        ), fnm22)

        expect("固定路径优先于 fnm", lookup(
            executables: ["/usr/local/bin/node", fnmDefault],
            majors: ["/usr/local/bin/node": 24]
        ), "/usr/local/bin/node")

        expect("跳过低于 20 的固定路径", lookup(
            executables: ["/usr/local/bin/node", fnm22],
            directories: ["\(fnm)/node-versions": ["v22.22.3"]],
            majors: ["/usr/local/bin/node": 16, fnm22: 22]
        ), fnm22)

        expect("nvm 默认别名", lookup(
            executables: [nvm22],
            directories: ["\(home)/.nvm/versions/node": ["v22.22.3"]],
            texts: ["\(home)/.nvm/alias/default": "22.22.3\n"]
        ), nvm22)

        expect("nvm 跟随 lts 别名", lookup(
            executables: [nvm22],
            directories: ["\(home)/.nvm/versions/node": ["v20.18.0", "v22.22.3"]],
            texts: [
                "\(home)/.nvm/alias/default": "lts/jod\n",
                "\(home)/.nvm/alias/lts/jod": "v22.22.3\n"
            ]
        ), nvm22)

        expect("asdf shim", lookup(executables: [asdf]), asdf)

        expect("登录 shell", lookup(
            executables: ["/Users/someone/.fnm-shell/bin/node"],
            shell: ["/Users/someone/.fnm-shell/bin/node"]
        ), "/Users/someone/.fnm-shell/bin/node")

        expect("zshrc 补上登录 shell 找不到的 node", lookup(
            executables: ["/opt/fnm/bin/node"],
            shell: ["", "/opt/fnm/bin/node"]
        ), "/opt/fnm/bin/node")

        expect("内置运行时优先", lookup(
            executables: ["/usr/local/bin/node", "/Applications/Busy Agents.app/node"],
            bundled: "/Applications/Busy Agents.app/node"
        ), "/Applications/Busy Agents.app/node")

        expect("都没有时返回空", lookup(executables: []), nil)

        if failed != 0 { exit(1) }
    }
}
