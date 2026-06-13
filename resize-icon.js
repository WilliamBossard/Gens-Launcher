const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
    try {
        const iconPath = path.join(__dirname, 'assets', 'icon.png');
        const image = nativeImage.createFromPath(iconPath);
        
        if (image.isEmpty()) {
            console.error('Failed to load image');
            app.quit();
            return;
        }

        const resized512 = image.resize({ width: 512, height: 512 });
        const png512 = resized512.toPNG();
        fs.writeFileSync(path.join(__dirname, 'assets', 'icon-512.png'), png512);
        
        const resized256 = image.resize({ width: 256, height: 256 });
        const png256 = resized256.toPNG();
        fs.writeFileSync(path.join(__dirname, 'assets', 'icon-256.png'), png256);

        console.log('Icons resized successfully');
    } catch (e) {
        console.error('Error:', e);
    }
    app.quit();
});
