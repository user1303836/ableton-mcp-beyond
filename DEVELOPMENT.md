# Development

From a copy of this repository, with Rust, Cargo and Python 3.11 or later:

```sh
cargo build --release --locked --workspace --bins
cargo run --release -p kumi --
sh scripts/test-isolated.sh  # PowerShell: ./scripts/test-isolated.ps1
```

Node.js 22 or 24 is needed for the retained TypeScript reference tests and
oracle generators. With Cargo available, `npm run setup` and `npm run kumi`
build and run this native checkout.

The [developer guide](docs/en/DEVELOPER_GUIDE.md) ([简体中文](docs/zh-CN/DEVELOPER_GUIDE.md) ·
[日本語](docs/ja/DEVELOPER_GUIDE.md)) covers the layout, working on each part and releasing;
[testing](docs/en/TESTING.md) covers every test and what CI runs.
