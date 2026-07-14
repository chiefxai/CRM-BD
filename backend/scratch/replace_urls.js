const fs = require('fs');
const path = require('path');

function replaceInDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      replaceInDir(fullPath);
    } else if (file.endsWith('.jsx') || file.endsWith('.js')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      
      // Let's replace any instance of:
      // const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";
      // to:
      // const API_BASE = window.location.origin;
      if (content.includes('http://localhost:8080') || content.includes('import.meta.env.VITE_API_BASE_URL')) {
        console.log(`Updating URLs in ${file}`);
        content = content.replace(/const\s+API_BASE\s+=\s+import\.meta\.env\.VITE_API_BASE_URL\s+\|\|\s+"http:\/\/localhost:8080"/g, 'const API_BASE = window.location.origin');
        content = content.replace(/import\.meta\.env\.VITE_API_BASE_URL\s+\|\|\s+"http:\/\/localhost:8080"/g, 'window.location.origin');
        content = content.replace(/http:\/\/localhost:8080/g, 'window.location.origin');
        content = content.replace(/import\.meta\.env\.VITE_API_BASE_URL/g, 'window.location.origin');
        fs.writeFileSync(fullPath, content, 'utf8');
      }
    }
  }
}

replaceInDir(path.join(__dirname, '../frontend/src'));
console.log('URLs replaced successfully.');
