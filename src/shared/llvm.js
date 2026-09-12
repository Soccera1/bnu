// LLVM's public C API supplies architecture instruction encoders/decoders.
// BNU owns option parsing and object/archive operations; no host CLI is invoked.
import {CString, dlopen, JSCallback, ptr, toArrayBuffer} from "bun:ffi";

let llvm, demangler;
const z = value => Buffer.from(`${value}\0`);
const pointer = bytes => Number(bytes.readBigUInt64LE());
export function llvmApi() {
  if (llvm) return llvm;
  const functions = {
    LLVMContextCreate: {args: [], returns: "ptr"},
    LLVMContextDispose: {args: ["ptr"], returns: "void"},
    LLVMContextSetDiagnosticHandler: {args: ["ptr", "ptr", "ptr"], returns: "void"},
    LLVMGetDiagInfoDescription: {args: ["ptr"], returns: "ptr"},
    LLVMGetDiagInfoSeverity: {args: ["ptr"], returns: "i32"},
    LLVMModuleCreateWithNameInContext: {args: ["ptr", "ptr"], returns: "ptr"},
    LLVMDisposeModule: {args: ["ptr"], returns: "void"},
    LLVMSetTarget: {args: ["ptr", "ptr"], returns: "void"},
    LLVMSetModuleInlineAsm2: {args: ["ptr", "ptr", "u64"], returns: "void"},
    LLVMGetTargetFromTriple: {args: ["ptr", "ptr", "ptr"], returns: "i32"},
    LLVMCreateTargetMachine:
        {args: ["ptr", "ptr", "ptr", "ptr", "i32", "i32", "i32"], returns: "ptr"},
    LLVMDisposeTargetMachine: {args: ["ptr"], returns: "void"},
    LLVMTargetMachineEmitToMemoryBuffer:
        {args: ["ptr", "ptr", "i32", "ptr", "ptr"], returns: "i32"},
    LLVMGetBufferStart: {args: ["ptr"], returns: "ptr"},
    LLVMGetBufferSize: {args: ["ptr"], returns: "u64"},
    LLVMDisposeMemoryBuffer: {args: ["ptr"], returns: "void"},
    LLVMDisposeMessage: {args: ["ptr"], returns: "void"},
    LLVMCreateDisasm: {args: ["ptr", "ptr", "i32", "ptr", "ptr"], returns: "ptr"},
    LLVMDisasmInstruction: {args: ["ptr", "ptr", "u64", "u64", "ptr", "u64"], returns: "u64"},
    LLVMDisasmDispose: {args: ["ptr"], returns: "void"},
    LLVMSetDisasmOptions: {args: ["ptr", "u64"], returns: "i32"},
  };
  for (const arch of ["X86", "AArch64", "ARM", "RISCV"])
    for (const suffix
             of ["TargetInfo", "Target", "TargetMC", "AsmParser", "AsmPrinter", "Disassembler"])
      functions[`LLVMInitialize${arch}${suffix}`] = {args: [], returns: "void"};
  const candidates = process.env.BNU_LLVM_LIBRARY ? [process.env.BNU_LLVM_LIBRARY] : [
    "libLLVM.so", ...Array.from({length: 12}, (_, i) => `libLLVM-${23 - i}.so`),
    ...Array.from({length: 12}, (_, i) => `libLLVM.so.${23 - i}.1`)
  ];
  for (const path of candidates) {
    try {
      const lib = dlopen(path, functions);
      llvm = lib.symbols;
      break;
    } catch {
    }
  }
  if (!llvm)
    throw new Error(
        "LLVM shared library not found; install libLLVM (12 or newer), or set BNU_LLVM_LIBRARY to its path");
  for (const arch of ["X86", "AArch64", "ARM", "RISCV"])
    for (const suffix
             of ["TargetInfo", "Target", "TargetMC", "AsmParser", "AsmPrinter", "Disassembler"])
      llvm[`LLVMInitialize${arch}${suffix}`]();
  return llvm;
}
export function assemble(source, triple, cpu = "generic", features = "", options = {}) {
  const api = llvmApi(), ctx = api.LLVMContextCreate(), target = Buffer.alloc(8),
        message = Buffer.alloc(8), buffer = Buffer.alloc(8), tripleBytes = z(triple),
        cpuBytes = z(cpu), featuresBytes = z(features), moduleName = z("bnu-as");
  let mod, tm;
  const diagnostics = [];
  const handler = new JSCallback(info => {
    const p = api.LLVMGetDiagInfoDescription(info);
    if (p) {
      diagnostics.push({ text: String(new CString(p)), severity: api.LLVMGetDiagInfoSeverity(info) });
      api.LLVMDisposeMessage(p);
    }
  }, {args: ["ptr", "ptr"], returns: "void"});
  const errorMessage = () => {
    const p = pointer(message);
    if (!p) return "assembly failed";
    const text = String(new CString(p));
    api.LLVMDisposeMessage(p);
    message.fill(0);
    return text;
  };
  try {
    api.LLVMContextSetDiagnosticHandler(ctx, handler.ptr, null);
    if (api.LLVMGetTargetFromTriple(ptr(tripleBytes), ptr(target), ptr(message)))
      throw new Error(errorMessage());
    tm = api.LLVMCreateTargetMachine(
        pointer(target), ptr(tripleBytes), ptr(cpuBytes), ptr(featuresBytes), 0, 0, 0);
    if (!tm) throw new Error("cannot create target machine");
    mod = api.LLVMModuleCreateWithNameInContext(ptr(moduleName), ctx);
    api.LLVMSetTarget(mod, ptr(tripleBytes));
    const text = Buffer.from(source.endsWith("\n") ? source : `${source}\n`);
    api.LLVMSetModuleInlineAsm2(mod, ptr(text), text.length);
    if (api.LLVMTargetMachineEmitToMemoryBuffer(tm, mod, 1, ptr(message), ptr(buffer)))
      throw new Error(diagnostics.map(item => item.text).join("\n") || errorMessage());
    const errors = diagnostics.filter(item => item.severity === 0 || (item.severity === 1 && options.fatalWarnings && !options.noWarn));
    if (errors.length) throw new Error(errors.map(item => item.text).join("\n"));
    if (!options.noWarn) for (const item of diagnostics.filter(item => item.severity === 1)) options.onWarning?.(item.text);
    const mem = pointer(buffer),
          data = Buffer.from(
              toArrayBuffer(api.LLVMGetBufferStart(mem), 0, Number(api.LLVMGetBufferSize(mem))));
    return Buffer.from(data);
  } finally {
    if (pointer(message)) api.LLVMDisposeMessage(pointer(message));
    if (pointer(buffer)) api.LLVMDisposeMemoryBuffer(pointer(buffer));
    if (tm) api.LLVMDisposeTargetMachine(tm);
    if (mod) api.LLVMDisposeModule(mod);
    api.LLVMContextDispose(ctx);
    handler.close();
  }
}
export function disassembler(triple, intel = false) {
  const api = llvmApi(), name = z(triple),
        ctx = api.LLVMCreateDisasm(ptr(name), null, 0, null, null);
  if (!ctx) throw new Error(`no disassembler for ${triple}`);
  if (intel) api.LLVMSetDisasmOptions(ctx, 4);
  return {
    instruction(bytes, address) {
      const output = Buffer.alloc(1024),
            size = Number(api.LLVMDisasmInstruction(
                ctx, ptr(bytes), bytes.length, address, ptr(output), output.length));
      return {size, text: output.subarray(0, output.indexOf(0)).toString().trim()};
    },
    close() {
      api.LLVMDisasmDispose(ctx);
    }
  };
}
export function objectTriple(obj) {
  const arch = obj.arch === "x86-64" ? "x86_64" :
      obj.arch === "i386"            ? "i386" :
      obj.arch === "riscv"           ? (obj.bits === 64 ? "riscv64" : "riscv32") :
                                       obj.arch;
  return `${arch}-${
      obj.format === "macho"                           ? "apple-darwin" :
          obj.format === "coff" || obj.format === "pe" ? "pc-windows-msvc" :
                                                         "unknown-linux-gnu"}`;
}
export function demangle(name, types = false) {
  if (!types && !/^_+Z/.test(name)) return name;
  if (demangler === undefined) {
    demangler = null;
    for (const path of ["libstdc++.so.6", "libc++abi.so.1"]) {
      try {
        demangler = dlopen(path, {
                      __cxa_demangle: {args: ["ptr", "ptr", "ptr", "ptr"], returns: "ptr"},
                      free: {args: ["ptr"], returns: "void"}
                    }).symbols;
        break;
      } catch {
      }
    }
  }
  if (!demangler) throw new Error("C++ ABI library not found; install libstdc++.so.6 or libc++abi.so.1 for demangling");
  const text = z(name.startsWith("__Z") ? name.slice(1) : name), status = Buffer.alloc(4),
        p = demangler.__cxa_demangle(ptr(text), null, null, ptr(status));
  if (!p) return name;
  try {
    return String(new CString(p));
  } finally {
    demangler.free(p);
  }
}
