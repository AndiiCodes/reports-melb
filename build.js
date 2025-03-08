const fs = require('fs');
const path = require('path');


console.log('Creating directories...');
if (!fs.existsSync('dist')) {
  fs.mkdirSync('dist');
}

if (!fs.existsSync('dist/api')) {
  fs.mkdirSync('dist/api');
}

console.log('Copying script.js...');
let scriptContent = fs.readFileSync('script.js', 'utf8');
fs.writeFileSync('dist/script.js', scriptContent);

console.log('Copying HTML and CSS files...');
fs.copyFileSync('index.html', 'dist/index.html');
if (fs.existsSync('style.css')) {
  fs.copyFileSync('style.css', 'dist/style.css');
}


console.log('Setting up API routes...');
if (fs.existsSync('api')) {
  const apiFiles = fs.readdirSync('api');
  apiFiles.forEach(file => {
    const sourcePath = path.join('api', file);
    const destPath = path.join('dist/api', file);
    console.log(`Copying ${sourcePath} to ${destPath}`);
    fs.copyFileSync(sourcePath, destPath);
  });
  console.log('API files copied to dist/api');
}

console.log('Build completed successfully!');
