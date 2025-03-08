module.exports = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    try {
      console.log('Supabase config API called');
      console.log('Environment variables check:', {
        urlPresent: !!process.env.SUPABASE_URL,
        keyPresent: !!process.env.SUPABASE_KEY
      });
      
      res.status(200).json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_KEY
      });
    } catch (error) {
      console.error('API route error:', error);
      res.status(500).json({ error: 'Failed to get Supabase configuration' });
    }
  };