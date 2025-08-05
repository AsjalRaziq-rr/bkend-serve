const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Ensure temp directory exists
const TEMP_DIR = path.join(__dirname, 'temp');
fs.ensureDirSync(TEMP_DIR);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'APK Compiler Service is running' });
});

// Main compilation endpoint
app.post('/compile-apk', async (req, res) => {
  const { manifest, mainActivity, layout, appName = 'GeneratedApp' } = req.body;
  
  if (!manifest || !mainActivity || !layout) {
    return res.status(400).json({ 
      error: 'Missing required files: manifest, mainActivity, or layout' 
    });
  }

  const projectId = uuidv4();
  const projectDir = path.join(TEMP_DIR, projectId);

  try {
    // Create Android project structure
    await createAndroidProject(projectDir, { manifest, mainActivity, layout, appName });
    
    // Compile the APK
    const apkPath = await compileAPK(projectDir, appName);
    
    // Send the APK file
    res.download(apkPath, `${appName}.apk`, (err) => {
      if (err) {
        console.error('Download error:', err);
      }
      // Cleanup after sending
      setTimeout(() => {
        fs.remove(projectDir).catch(console.error);
      }, 5000);
    });

  } catch (error) {
    console.error('Compilation error:', error);
    res.status(500).json({ 
      error: 'APK compilation failed', 
      details: error.message 
    });
    
    // Cleanup on error
    fs.remove(projectDir).catch(console.error);
  }
});

async function createAndroidProject(projectDir, { manifest, mainActivity, layout, appName }) {
  // Extract package name from manifest
  const packageMatch = manifest.match(/package="([^"]+)"/);
  const packageName = packageMatch ? packageMatch[1] : 'com.apkforge.app';
  const packagePath = packageName.replace(/\./g, '/');

  // Create directory structure
  const dirs = [
    'app/src/main/java/' + packagePath,
    'app/src/main/res/layout',
    'app/src/main/res/values',
    'app/src/main/res/drawable',
    'app/src/main/res/mipmap-hdpi',
    'app/src/main/res/mipmap-mdpi',
    'app/src/main/res/mipmap-xhdpi',
    'app/src/main/res/mipmap-xxhdpi',
    'app/src/main/res/mipmap-xxxhdpi'
  ];

  for (const dir of dirs) {
    await fs.ensureDir(path.join(projectDir, dir));
  }

  // Write main files
  await fs.writeFile(path.join(projectDir, 'app/src/main/AndroidManifest.xml'), manifest);
  await fs.writeFile(path.join(projectDir, `app/src/main/java/${packagePath}/MainActivity.java`), mainActivity);
  await fs.writeFile(path.join(projectDir, 'app/src/main/res/layout/activity_main.xml'), layout);

  // Create strings.xml
  const stringsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${appName}</string>
</resources>`;
  await fs.writeFile(path.join(projectDir, 'app/src/main/res/values/strings.xml'), stringsXml);

  // Create build.gradle (Project level)
  const projectBuildGradle = `buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.1.0'
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

task clean(type: Delete) {
    delete rootProject.buildDir
}`;
  await fs.writeFile(path.join(projectDir, 'build.gradle'), projectBuildGradle);

  // Create app/build.gradle
  const appBuildGradle = `plugins {
    id 'com.android.application'
}

android {
    namespace '${packageName}'
    compileSdk 34

    defaultConfig {
        applicationId "${packageName}"
        minSdk 21
        targetSdk 34
        versionCode 1
        versionName "1.0"
    }

    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }
}

dependencies {
    implementation 'androidx.appcompat:appcompat:1.6.1'
    implementation 'com.google.android.material:material:1.9.0'
    implementation 'androidx.constraintlayout:constraintlayout:2.1.4'
}`;
  await fs.writeFile(path.join(projectDir, 'app/build.gradle'), appBuildGradle);

  // Create gradle.properties with reduced memory usage
  const gradleProperties = `org.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8
org.gradle.daemon=false
org.gradle.parallel=false
org.gradle.configureondemand=false
android.useAndroidX=true
android.enableJetifier=true
android.builder.sdkDownload=false`;
  await fs.writeFile(path.join(projectDir, 'gradle.properties'), gradleProperties);

  // Create settings.gradle
  const settingsGradle = `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "${appName}"
include ':app'`;
  await fs.writeFile(path.join(projectDir, 'settings.gradle'), settingsGradle);

  // Create basic app icon (placeholder)
  const iconDirs = ['mipmap-hdpi', 'mipmap-mdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'];
  for (const iconDir of iconDirs) {
    // Create a simple placeholder icon file (you'd need actual icon files in production)
    await fs.writeFile(
      path.join(projectDir, `app/src/main/res/${iconDir}/ic_launcher.png`), 
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64')
    );
  }
}

async function compileAPK(projectDir, appName) {
  return new Promise(async (resolve, reject) => {
    try {
      // Create gradlew wrapper files and download jar
      await createGradleWrapper(projectDir);
      
      const isWindows = process.platform === 'win32';
      const gradleCmd = isWindows ? 'gradlew.bat' : './gradlew';

    const gradle = spawn(gradleCmd, [
      'assembleRelease',
      '-Dorg.gradle.daemon=false',
      '-Dorg.gradle.jvmargs=-Xmx512m -XX:MaxMetaspaceSize=256m -XX:MaxDirectMemorySize=64m',
      '--no-build-cache',
      '--no-configuration-cache',
      '--parallel=false',
      '--max-workers=1'
    ], {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows,
      env: { ...process.env, GRADLE_OPTS: '-Xmx512m -XX:MaxMetaspaceSize=256m' }
    });

    let output = '';
    let errorOutput = '';

    gradle.stdout.on('data', (data) => {
      output += data.toString();
      console.log('Gradle output:', data.toString());
    });

    gradle.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.error('Gradle error:', data.toString());
    });

    gradle.on('close', (code) => {
      if (code === 0) {
        const apkPath = path.join(projectDir, 'app/build/outputs/apk/release/app-release-unsigned.apk');
        
        // Check if APK exists
        if (fs.existsSync(apkPath)) {
          resolve(apkPath);
        } else {
          reject(new Error('APK file not found after build'));
        }
      } else {
        reject(new Error(`Gradle build failed with code ${code}: ${errorOutput}`));
      }
    });

    } catch (setupError) {
      reject(new Error(`Failed to setup Gradle wrapper: ${setupError.message}`));
    }
  });
}

function createGradleWrapper(projectDir) {
  // Create gradlew script
  const gradlewScript = `#!/usr/bin/env sh

##############################################################################
##
##  Gradle start up script for UN*X
##
##############################################################################

# Resolve links: $0 may be a link
PRG="$0"
# Need this for relative symlinks.
while [ -h "$PRG" ] ; do
    ls=\`ls -ld "$PRG"\`
    link=\`expr "$ls" : '.*-> \\(.*\\)$'\`
    if expr "$link" : '/.*' > /dev/null; then
        PRG="$link"
    else
        PRG=\`dirname "$PRG"\`"/$link"
    fi
done
SAVED="\`pwd\`"
cd "\`dirname \\"$PRG\\"\`/" >/dev/null
APP_HOME="\`pwd -P\`"
cd $SAVED >/dev/null

APP_NAME="Gradle"
APP_BASE_NAME=\`basename "$0"\`

# Use the maximum available, or set MAX_FD != -1 to use that value.
MAX_FD="maximum"

warn () {
    echo "$*"
}

die () {
    echo
    echo "$*"
    echo
    exit 1
}

# OS specific support (must be 'true' or 'false').
cygwin=false
msys=false
darwin=false
nonstop=false
case "\`uname\`" in
  CYGWIN* )
    cygwin=true
    ;;
  Darwin* )
    darwin=true
    ;;
  MINGW* )
    msys=true
    ;;
  NONSTOP* )
    nonstop=true
    ;;
esac

CLASSPATH=$APP_HOME/gradle/wrapper/gradle-wrapper.jar

# Determine the Java command to use to start the JVM.
if [ -n "$JAVA_HOME" ] ; then
    if [ -x "$JAVA_HOME/jre/sh/java" ] ; then
        # IBM's JDK on AIX uses strange locations for the executables
        JAVACMD="$JAVA_HOME/jre/sh/java"
    else
        JAVACMD="$JAVA_HOME/bin/java"
    fi
    if [ ! -x "$JAVACMD" ] ; then
        die "ERROR: JAVA_HOME is set to an invalid directory: $JAVA_HOME"
    fi
else
    JAVACMD="java"
    which java >/dev/null 2>&1 || die "ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH."
fi

# Increase the maximum file descriptors if we can.
if [ "$cygwin" = "false" -a "$darwin" = "false" -a "$nonstop" = "false" ] ; then
    MAX_FD_LIMIT=\`ulimit -H -n\`
    if [ $? -eq 0 ] ; then
        if [ "$MAX_FD" = "maximum" -o "$MAX_FD" = "max" ] ; then
            MAX_FD="$MAX_FD_LIMIT"
        fi
        ulimit -n $MAX_FD
        if [ $? -ne 0 ] ; then
            warn "Could not set maximum file descriptor limit: $MAX_FD"
        fi
    else
        warn "Could not query maximum file descriptor limit: $MAX_FD_LIMIT"
    fi
fi

exec "$JAVACMD" \\
    -classpath "$CLASSPATH" \\
    org.gradle.wrapper.GradleWrapperMain \\
    "$@"`;

  fs.writeFileSync(path.join(projectDir, 'gradlew'), gradlewScript);
  fs.chmodSync(path.join(projectDir, 'gradlew'), '755');

  // Create gradle wrapper directory and properties
  fs.ensureDirSync(path.join(projectDir, 'gradle/wrapper'));
  
  const wrapperProperties = `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.2-bin.zip
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists`;
  
  fs.writeFileSync(path.join(projectDir, 'gradle/wrapper/gradle-wrapper.properties'), wrapperProperties);
  
  // Download gradle-wrapper.jar from GitHub
  const gradleWrapperJar = path.join(projectDir, 'gradle/wrapper/gradle-wrapper.jar');
  const https = require('https');
  const http = require('http');
  
  return new Promise((resolve, reject) => {
    // Use GitHub raw content URL for gradle-wrapper.jar
    const jarUrl = 'https://github.com/gradle/gradle/raw/v8.2.1/gradle/wrapper/gradle-wrapper.jar';
    
    function downloadFile(url, redirectCount = 0) {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      
      const client = url.startsWith('https:') ? https : http;
      
      client.get(url, (response) => {
        if (response.statusCode === 200) {
          const fileStream = fs.createWriteStream(gradleWrapperJar);
          response.pipe(fileStream);
          
          fileStream.on('finish', () => {
            fileStream.close();
            console.log('Gradle wrapper jar downloaded successfully');
            resolve();
          });
          
          fileStream.on('error', (err) => {
            fs.unlink(gradleWrapperJar, () => {}); // Delete the file on error
            reject(err);
          });
        } else if (response.statusCode === 302 || response.statusCode === 301) {
          // Handle redirects
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            console.log(`Following redirect to: ${redirectUrl}`);
            downloadFile(redirectUrl, redirectCount + 1);
          } else {
            reject(new Error('Redirect without location header'));
          }
        } else {
          reject(new Error(`Failed to download gradle-wrapper.jar: ${response.statusCode}`));
        }
      }).on('error', (err) => {
        reject(err);
      });
    }
    
    downloadFile(jarUrl);
  });
}

app.listen(PORT, () => {
  console.log(`APK Compiler Service running on port ${PORT}`);
  console.log('Endpoints:');
  console.log(`  GET  /health - Health check`);
  console.log(`  POST /compile-apk - Compile APK from code`);
});
