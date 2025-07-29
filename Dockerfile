# Use Ubuntu as base image for Android SDK
FROM ubuntu:22.04

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$PATH:$ANDROID_HOME/tools:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    unzip \
    openjdk-11-jdk \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Create android sdk directory
RUN mkdir -p $ANDROID_HOME

# Download and install Android SDK command line tools
RUN wget https://dl.google.com/android/repository/commandlinetools-linux-9477386_latest.zip \
    && unzip commandlinetools-linux-9477386_latest.zip -d $ANDROID_HOME \
    && rm commandlinetools-linux-9477386_latest.zip \
    && mkdir -p $ANDROID_HOME/cmdline-tools/latest \
    && mv $ANDROID_HOME/cmdline-tools/* $ANDROID_HOME/cmdline-tools/latest/ || true

# Accept licenses and install SDK components
RUN yes | sdkmanager --licenses
RUN sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

# Set working directory
WORKDIR /app

# Copy package
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Copy application code
COPY . .

# Create temp directory
RUN mkdir -p temp

# Expose port
EXPOSE 3001

# Start the application
CMD ["npm", "start"]
