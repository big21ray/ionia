interface FileBrowserProps {
  onFileSelect: (path: string) => void;
}

const FileBrowser = ({ onFileSelect }: FileBrowserProps) => {
  const handleOpenFile = async () => {
    if (window.electronAPI) {
      try {
        const result = await window.electronAPI.openFileDialog();
        if (result && !result.canceled && result.filePaths.length > 0) {
          onFileSelect(result.filePaths[0]);
        }
      } catch (error) {
        console.error('Error opening file:', error);
      }
    } else {
      // Fallback for development (using HTML5 file input)
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          onFileSelect(URL.createObjectURL(file));
        }
      };
      input.click();
    }
  };

  return (
    <div className="flex flex-col items-center justify-center space-y-6">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-white mb-2">Ionia</h1>
        <p className="text-gray-400">Video Player</p>
      </div>
      <button
        onClick={handleOpenFile}
        className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-medium transition-colors shadow-lg"
      >
        Open Video File
      </button>
    </div>
  );
};

export default FileBrowser;





