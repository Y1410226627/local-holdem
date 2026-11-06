#!/usr/bin/env node
/**
 * 一键构建安卓 APK：Web 构建 → Capacitor 同步 → 在纯 ASCII 构建目录里 Gradle 打包。
 *
 * 为什么要用 ASCII 构建目录：AGP 在 Windows 上会拒绝包含中文/非 ASCII 的项目路径
 * （本项目位于 D:\德州扑克），所以先把 android/ 复制到 C:\AndroidToolchain\apk-build
 * 再构建，产物最后复制回 apk/。
 *
 * 用法：
 *   npm run apk                # 构建签名后的 release APK
 *   npm run apk:debug          # 构建 debug APK
 *   node scripts/build-apk.mjs --skip-web   # 跳过 npm run build（复用已有 dist）
 *
 * 环境要求（本机已预装，可用环境变量覆盖）：
 *   JDK 21+          JAVA_HOME / HOLDEM_JDK      默认 C:\AndroidToolchain\jdk21
 *   Android SDK      ANDROID_HOME                默认 C:\AndroidToolchain\sdk
 *   Gradle 缓存      GRADLE_USER_HOME            默认 C:\AndroidToolchain\gradle-home
 *   构建目录         HOLDEM_APK_BUILD_DIR        默认 C:\AndroidToolchain\apk-build（必须是 ASCII 路径）
 *   签名密钥目录     HOLDEM_KEYSTORE_DIR         默认 C:\AndroidToolchain\keystore
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

const args = process.argv.slice(2);
const wantDebug = args.includes('--debug');
const skipWeb = args.includes('--skip-web');

const DEFAULT_JDK_DIR = 'C:\\AndroidToolchain\\jdk21';
const DEFAULT_SDK_DIR = 'C:\\AndroidToolchain\\sdk';
const DEFAULT_GRADLE_HOME = 'C:\\AndroidToolchain\\gradle-home';
const DEFAULT_BUILD_DIR = 'C:\\AndroidToolchain\\apk-build';
const DEFAULT_KEYSTORE_DIR = 'C:\\AndroidToolchain\\keystore';

function log(message) {
  console.log(`\n[apk] ${message}`);
}

function fail(message) {
  console.error(`\n[apk] 失败：${message}`);
  process.exit(1);
}

function isAscii(value) {
  return /^[\x00-\x7F]*$/.test(value);
}

/** 读取 JDK 的 release 文件，返回主版本号（读不到返回 0）。 */
async function javaMajorVersion(jdkHome) {
  const releaseFile = path.join(jdkHome, 'release');
  try {
    const text = await readFile(releaseFile, 'utf8');
    const match = /^JAVA_VERSION="?(\d+)/m.exec(text);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/** 在候选目录里找 JDK（21 及以上优先，版本最高者优先）。 */
async function findJdk() {
  const candidates = [];
  const envJdk = process.env.HOLDEM_JDK || process.env.JAVA_HOME;
  if (envJdk) candidates.push(envJdk);
  for (const base of ['C:\\AndroidToolchain', DEFAULT_JDK_DIR]) {
    if (!existsSync(base)) continue;
    candidates.push(base);
    try {
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^jdk/i.test(entry.name)) candidates.push(path.join(base, entry.name));
      }
    } catch {
      // 忽略无权限目录
    }
  }

  let best = null;
  for (const candidate of candidates) {
    if (!existsSync(path.join(candidate, 'bin', 'javac.exe'))) continue;
    const major = await javaMajorVersion(candidate);
    if (major < 21) continue;
    if (!best || major > best.major) best = { home: candidate, major };
  }
  return best;
}

/** 找 Android SDK（必须带 platforms 目录）。 */
function findSdk() {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, DEFAULT_SDK_DIR];
  for (const candidate of candidates) {
    if (candidate && existsSync(path.join(candidate, 'platforms'))) return candidate;
  }
  return null;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: 'inherit',
      ...options,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function runOrFail(command, commandArgs, options, what) {
  const code = await run(command, commandArgs, options);
  if (code !== 0) fail(`${what}失败（退出码 ${code}）`);
}

async function sha256(file) {
  const buffer = await readFile(file);
  return createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const version = packageJson.version;

  const jdk = await findJdk();
  if (!jdk) {
    fail(
      '找不到 JDK 21+。请安装 JDK 21（例如解压到 C:\\AndroidToolchain\\jdk21），' +
        '或设置环境变量 HOLDEM_JDK / JAVA_HOME 指向 JDK 21 目录。',
    );
  }
  log(`JDK：${jdk.home}（Java ${jdk.major}）`);

  const sdk = findSdk();
  if (!sdk) {
    fail('找不到 Android SDK。请设置 ANDROID_HOME 指向含 platforms 的 SDK 目录（默认 C:\\AndroidToolchain\\sdk）。');
  }
  log(`Android SDK：${sdk}`);

  const buildDir = process.env.HOLDEM_APK_BUILD_DIR || DEFAULT_BUILD_DIR;
  if (!isAscii(buildDir)) {
    fail(`构建目录必须是纯 ASCII 路径（当前：${buildDir}）。可用 HOLDEM_APK_BUILD_DIR 指定，例如 C:\\AndroidToolchain\\apk-build。`);
  }

  const gradleHome =
    process.env.GRADLE_USER_HOME || (existsSync(DEFAULT_GRADLE_HOME) ? DEFAULT_GRADLE_HOME : null);
  const androidProject = path.join(rootDir, 'android');
  if (!existsSync(path.join(androidProject, 'gradlew.bat'))) {
    fail('缺少 android/ 工程。请先运行 npx cap add android 生成（或从仓库重新拉取）。');
  }

  log(`目标版本：${version}（${wantDebug ? 'debug' : 'release'}）`);

  if (!skipWeb) {
    log('1/5 构建 Web 资源（npm run build）…');
    await runOrFail('npm', ['run', 'build'], { cwd: rootDir, shell: process.platform === 'win32' }, 'Web 构建');
  } else {
    log('1/5 跳过 Web 构建（--skip-web）');
  }

  log('2/5 同步资源到安卓工程（npx cap sync android）…');
  const capBin = path.join(rootDir, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
  if (!existsSync(capBin)) fail('缺少 @capacitor/cli，请先运行 npm install。');
  await runOrFail(process.execPath, [capBin, 'sync', 'android'], { cwd: rootDir }, 'Capacitor 同步');

  log(`3/5 复制工程到 ASCII 构建目录：${buildDir}`);
  await rm(path.join(buildDir, 'android'), { recursive: true, force: true });
  await rm(path.join(buildDir, 'node_modules'), { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  await cp(androidProject, path.join(buildDir, 'android'), { recursive: true });
  await cp(path.join(rootDir, 'package.json'), path.join(buildDir, 'package.json'));
  const capacitorModule = path.join(rootDir, 'node_modules', '@capacitor', 'android', 'capacitor');
  const stagedModule = path.join(buildDir, 'node_modules', '@capacitor', 'android', 'capacitor');
  await mkdir(path.dirname(stagedModule), { recursive: true });
  await cp(capacitorModule, stagedModule, { recursive: true });

  const stagedAndroid = path.join(buildDir, 'android');
  await writeFile(
    path.join(stagedAndroid, 'local.properties'),
    `sdk.dir=${sdk.replace(/\\/g, '/')}\n`,
    'utf8',
  );

  if (!wantDebug) {
    const keystoreDir = process.env.HOLDEM_KEYSTORE_DIR || DEFAULT_KEYSTORE_DIR;
    const storeFile = path.join(keystoreDir, 'local-holdem-release.jks');
    const storePassword = process.env.HOLDEM_KEYSTORE_PASSWORD || 'local-holdem-2026';
    const keyAlias = 'localholdem';
    if (!existsSync(storeFile)) {
      log(`4/5 生成发布签名密钥：${storeFile}`);
      await mkdir(keystoreDir, { recursive: true });
      const keytool = path.join(jdk.home, 'bin', 'keytool.exe');
      await runOrFail(
        keytool,
        [
          '-genkeypair',
          '-v',
          '-keystore',
          storeFile,
          '-alias',
          keyAlias,
          '-keyalg',
          'RSA',
          '-keysize',
          '2048',
          '-validity',
          '10000',
          '-storepass',
          storePassword,
          '-keypass',
          storePassword,
          '-dname',
          'CN=Local Holdem, OU=Local, O=Local Holdem, L=Local, ST=Local, C=CN',
        ],
        {},
        '生成签名密钥',
      );
    } else {
      log('4/5 复用已有发布签名密钥（保证覆盖安装升级）');
    }
    await writeFile(
      path.join(stagedAndroid, 'keystore.properties'),
      [
        `storeFile=${storeFile.replace(/\\/g, '/')}`,
        `storePassword=${storePassword}`,
        `keyAlias=${keyAlias}`,
        `keyPassword=${storePassword}`,
        '',
      ].join('\n'),
      'utf8',
    );
  } else {
    log('4/5 debug 构建：跳过发布签名');
  }

  log('5/5 Gradle 打包（首次构建会下载依赖，可能需要几分钟）…');
  const env = { ...process.env, JAVA_HOME: jdk.home, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
  env.PATH = `${path.join(jdk.home, 'bin')}${path.delimiter}${env.PATH ?? ''}`;
  if (gradleHome) env.GRADLE_USER_HOME = gradleHome;
  const task = wantDebug ? 'assembleDebug' : 'assembleRelease';
  await runOrFail(
    path.join(stagedAndroid, 'gradlew.bat'),
    [task, '--no-daemon', '--stacktrace'],
    { cwd: stagedAndroid, env, shell: process.platform === 'win32' },
    'Gradle 打包',
  );

  const buildType = wantDebug ? 'debug' : 'release';
  const apkSource = path.join(stagedAndroid, 'app', 'build', 'outputs', 'apk', buildType, `app-${buildType}.apk`);
  if (!existsSync(apkSource)) fail(`没有找到构建产物：${apkSource}`);

  const outputDir = path.join(rootDir, 'apk');
  await mkdir(outputDir, { recursive: true });
  for (const entry of await readdir(outputDir)) {
    if (entry.toLowerCase().endsWith('.apk')) await rm(path.join(outputDir, entry), { force: true });
  }
  const suffix = wantDebug ? '-debug' : '';
  const apkName = `德州扑克-v${version}${suffix}.apk`;
  const apkFile = path.join(outputDir, apkName);
  await cp(apkSource, apkFile);
  const apkStat = await stat(apkFile);
  const digest = await sha256(apkFile);

  console.log('\n============================================================');
  console.log('APK_RESULT=OK');
  console.log(`APK_PATH=${apkFile}`);
  console.log(`APK_SIZE_BYTES=${apkStat.size}`);
  console.log(`APK_SIZE_MB=${(apkStat.size / 1024 / 1024).toFixed(2)}`);
  console.log(`APK_SHA256=${digest}`);
  console.log('安装：把 apk 文件传到安卓手机（QQ/微信/USB）→ 点击安装 → 允许“安装未知应用”。');
  console.log('============================================================');
}

main().catch((error) => {
  console.error(error);
  fail(error instanceof Error ? error.message : String(error));
});
