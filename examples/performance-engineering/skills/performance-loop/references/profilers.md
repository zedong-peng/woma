# Profiler routing

Choose an existing repository tool first. Otherwise use the smallest available option that measures the suspected resource.

| Stack | CPU / wall time | Memory / allocation | System view |
| --- | --- | --- | --- |
| C / C++ on Linux | `perf record`, `perf report` | heaptrack, ASan allocator stats | `perf stat`, `/usr/bin/time -v` |
| C / C++ on macOS | Instruments Time Profiler | Instruments Allocations | `sample`, `powermetrics` |
| Rust | cargo-flamegraph, `perf` | heaptrack, dhat | `perf stat`, `/usr/bin/time -l` |
| Python | py-spy, cProfile | memray, tracemalloc | `/usr/bin/time` |
| Node.js | `node --prof`, Clinic Flame | heap snapshots, Clinic Heap | `node --trace-gc`, `/usr/bin/time` |
| Go | pprof CPU profile | pprof heap profile | `go test -bench` metrics |
| Java / JVM | async-profiler, JFR | JFR, async-profiler alloc | JFR, GC logs |

Do not install a profiler without checking repository policy and platform support. When no profiler is available, add narrow instrumentation around the benchmark path and remove it after collecting evidence.
