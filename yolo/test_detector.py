import unittest
import numpy as np
from detector import letterbox, postprocess

class DetectorContractTests(unittest.TestCase):
    def test_letterbox_keeps_geometry_and_rgb(self):
        frame=np.zeros((180,320,3),dtype=np.uint8); frame[:]=[0,0,255]
        image,scale,x,y=letterbox(frame)
        self.assertEqual(image.shape,(640,640,3))
        self.assertEqual((scale,x,y),(2,0,140))
        self.assertEqual(image[140,0].tolist(),[255,0,0])
        self.assertEqual(image[0,0].tolist(),[114,114,114])

    def test_dfl_decodes_and_filters_nonvehicles(self):
        outputs=[]
        for i in range(3):
            reg=np.full((1,64,1,1),-100,dtype=np.float32)
            for side in range(4): reg[0,side*16+1,0,0]=100
            cls=np.zeros((1,80,1,1),dtype=np.float32)
            cls[0,2 if i!=2 else 0,0,0]=.9
            outputs.extend([reg,cls])
        result=postprocess(outputs)
        self.assertEqual(len(result),1) # identical car boxes suppress across branches
        self.assertEqual(result[0]['class'],'car')
        self.assertAlmostEqual(result[0]['confidence'],.9,places=6)
        self.assertEqual(result[0]['box'],[-320,-320,960,960])

    def test_rejects_incompatible_export(self):
        with self.assertRaises(ValueError): postprocess([np.zeros((1,84,8400))])

if __name__=='__main__': unittest.main()
